// Insights > Plan and Insights > Performance (Health is renderInsights in
// options.js). Loaded after options.js on the options page and shares its data:
//  - optClickup.state      the dashboard's ClickUp state (week bundles, waiting)
//  - insCache              every open task assigned to me (CLICKUP_OPEN_TASKS,
//                          also kept in storage - see insHydrate)
//  - perfHistory (storage) 12 weeks of tracked time + finished tasks, built by
//                          the background (PERF_HISTORY) at most every 6 hours
// Nothing here talks to ClickUp directly, and both tabs paint at once from what
// is stored; a stale copy refreshes quietly in the background.
(() => {
  "use strict";
  const DAY = 86400000, H = 3600000, MIN = 60000;
  const esc = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  const fmt = (ms) => {
    const m = Math.round((Number(ms) || 0) / MIN);
    if (m <= 0) return "0m";
    const h = Math.floor(m / 60), r = m % 60;
    return h ? h + "h" + (r ? " " + r + "m" : "") : r + "m";
  };
  const dayStart = (ts) => { const d = new Date(ts); d.setHours(0, 0, 0, 0); return d.getTime(); };
  const monday = (ts) => { const d = new Date(dayStart(ts)); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return d.getTime(); };
  const addDays = (ts, n) => { const d = new Date(ts); d.setDate(d.getDate() + n); return d.getTime(); };
  const dShort = (ts) => new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const dDay = (ts) => new Date(ts).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
  const isHoliday = (ts) => { try { return !!(window.PcmCalendar && window.PcmCalendar.isHoliday(ts)); } catch (e) { return false; } };
  const isWorkday = (ts) => { const g = new Date(ts).getDay(); return g !== 0 && g !== 6 && !isHoliday(ts); };
  const round15 = (ms) => Math.max(15 * MIN, Math.round(ms / (15 * MIN)) * 15 * MIN);
  const plural = (n, w) => n + " " + w + (n === 1 ? "" : "s");
  const ago = (at) => {
    const s = Math.max(0, (Date.now() - at) / 1000);
    if (s < 90) return "just now";
    if (s < 3600) return Math.round(s / 60) + " min ago";
    if (s < 86400) return Math.round(s / 3600) + "h ago";
    return dShort(at);
  };
  const taskUrl = (id) => "https://app.clickup.com/t/" + encodeURIComponent(id);
  const state = () => (typeof optClickup !== "undefined" && optClickup && optClickup.state) || {};
  const targetMs = () => { const h = Number(typeof optClickup !== "undefined" && optClickup && optClickup.targetHours); return (h > 0 ? h : 7) * H; };
  const openRows = () => (typeof insCache !== "undefined" && insCache && insCache.status === "ok" && Array.isArray(insCache.data)) ? insCache.data : null;

  // ---------- styles ----------
  const css = document.createElement("style");
  css.textContent = `
  #insPlusView { font-size: 13px; }
  #insPlusView h2 { margin: 0; font-size: 18px; }
  #insPlusView .ip-head { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; margin: 0 0 4px; }
  #insPlusView .ip-head .sp { flex: 1; }
  #insPlusView .ip-sub { color: var(--muted); margin: 0 0 16px; line-height: 1.5; max-width: 760px; }
  #insPlusView .ip-seg { display: inline-flex; border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
  #insPlusView .ip-seg button { font: inherit; font-size: 12px; padding: 5px 12px; border: 0; background: var(--card); color: var(--muted); cursor: pointer; }
  #insPlusView .ip-seg button.on { background: var(--indigo); color: #fff; }
  #insPlusView .ip-btn { font: inherit; font-size: 12px; padding: 4px 10px; border: 1px solid var(--border); border-radius: 7px; background: var(--card); color: var(--text); cursor: pointer; }
  #insPlusView .ip-btn:hover { border-color: var(--indigo); color: var(--indigo); }
  #insPlusView .ip-card { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 16px 18px; margin: 0 0 14px; }
  #insPlusView .ip-card h3 { margin: 0 0 4px; font-size: 14px; }
  #insPlusView .ip-card .hint { color: var(--muted); font-size: 12px; line-height: 1.5; margin: 0 0 12px; }
  #insPlusView .ip-meta { color: var(--muted); font-size: 11.5px; }
  #insPlusView .chip { display: inline-block; font-size: 11px; font-weight: 600; padding: 2px 9px; border-radius: 999px; white-space: nowrap; }
  #insPlusView .chip.good { background: rgba(22,163,74,.14); color: var(--green); }
  #insPlusView .chip.warn { background: rgba(217,119,6,.15); color: var(--amber); }
  #insPlusView .chip.bad { background: rgba(220,38,38,.13); color: var(--red); }
  #insPlusView .chip.mut { background: var(--bg2, rgba(0,0,0,.06)); color: var(--muted); font-weight: 500; }
  #insPlusView a { color: var(--indigo); text-decoration: none; }
  #insPlusView a:hover { text-decoration: underline; }
  /* summary */
  #insPlusView .ip-stats { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; margin: 12px 0 14px; }
  #insPlusView .ip-stat { border: 1px solid var(--border); border-radius: 10px; padding: 10px 12px; }
  #insPlusView .ip-stat .k { font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: .05em; font-weight: 700; }
  #insPlusView .ip-stat .v { font-size: 22px; font-weight: 700; margin-top: 2px; }
  #insPlusView .ip-stat .s { font-size: 11.5px; color: var(--muted); margin-top: 2px; }
  #insPlusView .ip-stat.good .v { color: var(--green); } #insPlusView .ip-stat.warn .v { color: var(--amber); } #insPlusView .ip-stat.bad .v { color: var(--red); }
  #insPlusView .ip-bar { position: relative; height: 12px; border-radius: 6px; background: var(--bg2, rgba(0,0,0,.06)); margin: 6px 0 8px; }
  #insPlusView .ip-bar i { position: absolute; top: 0; bottom: 0; }
  #insPlusView .ip-bar i:first-child { border-radius: 6px 0 0 6px; }
  #insPlusView .ip-bar i.cfg { background: var(--indigo); }
  #insPlusView .ip-bar i.est { background: var(--amber); }
  #insPlusView .ip-bar i.sug { background: repeating-linear-gradient(45deg, rgba(217,119,6,.6) 0 5px, rgba(217,119,6,.25) 5px 10px); }
  #insPlusView .ip-bar i.rev { background: #0d9488; }
  #insPlusView .ip-bar b { position: absolute; top: -5px; bottom: -5px; width: 2px; background: var(--text); }
  #insPlusView .ip-bar b span { position: absolute; top: -17px; left: 50%; transform: translateX(-50%); font-size: 10.5px; font-weight: 700; white-space: nowrap; color: var(--text); }
  #insPlusView .ip-legend { display: flex; flex-wrap: wrap; gap: 14px; font-size: 11.5px; color: var(--muted); }
  #insPlusView .ip-legend span::before { content: ""; display: inline-block; width: 9px; height: 9px; border-radius: 2px; margin-right: 5px; vertical-align: -1px; background: var(--c); }
  /* groups (details) */
  #insPlusView details.ip-grp { border: 1px solid var(--border); border-radius: 10px; margin: 0 0 8px; overflow: hidden; }
  #insPlusView details.ip-grp > summary { list-style: none; cursor: pointer; display: flex; align-items: center; gap: 10px; padding: 10px 12px; font-weight: 600; }
  #insPlusView details.ip-grp > summary::-webkit-details-marker { display: none; }
  #insPlusView details.ip-grp > summary::before { content: "▸"; color: var(--muted); font-size: 11px; transition: transform .15s; }
  #insPlusView details.ip-grp[open] > summary::before { transform: rotate(90deg); }
  #insPlusView details.ip-grp > summary .sp { flex: 1; }
  #insPlusView details.ip-grp > summary .tot { font-variant-numeric: tabular-nums; }
  #insPlusView details.ip-grp > summary .dot { width: 9px; height: 9px; border-radius: 2px; background: var(--c); flex: none; }
  #insPlusView details.ip-grp > .body { padding: 0 12px 6px; border-top: 1px solid var(--border); }
  #insPlusView .ip-total { display: flex; justify-content: space-between; padding: 8px 12px 0; font-weight: 700; }
  /* one task per line */
  #insPlusView .ip-row { display: grid; grid-template-columns: 22px minmax(0, 1fr) auto; gap: 8px; align-items: start; padding: 7px 0; border-top: 1px dashed var(--border); }
  #insPlusView .ip-row:first-child { border-top: 0; }
  #insPlusView .ip-row .no { color: var(--muted); font-size: 11px; padding-top: 1px; text-align: right; }
  #insPlusView .ip-row .nm { min-width: 0; }
  #insPlusView .ip-row .nm a, #insPlusView .ip-row .nm .t { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  #insPlusView .ip-row .sub { font-size: 11.5px; color: var(--muted); margin-top: 2px; display: flex; flex-wrap: wrap; gap: 4px 8px; align-items: center; }
  #insPlusView .ip-row .tm { font-weight: 600; white-space: nowrap; font-variant-numeric: tabular-nums; text-align: right; }
  #insPlusView .ip-row .tm small { display: block; font-weight: 400; color: var(--muted); font-size: 11px; }
  #insPlusView .flag { font-size: 10.5px; font-weight: 600; padding: 1px 7px; border-radius: 999px; }
  #insPlusView .flag.bad { background: rgba(220,38,38,.12); color: var(--red); }
  #insPlusView .flag.warn { background: rgba(217,119,6,.14); color: var(--amber); }
  #insPlusView .flag.mut { background: var(--bg2, rgba(0,0,0,.06)); color: var(--muted); }
  #insPlusView .ip-daybar { height: 6px; border-radius: 3px; background: var(--bg2, rgba(0,0,0,.06)); width: 90px; overflow: hidden; }
  #insPlusView .ip-daybar i { display: block; height: 100%; background: var(--indigo); }
  #insPlusView .ip-apply { font-size: 11.5px; padding: 3px 10px; font-weight: 600; color: var(--indigo); border-color: var(--indigo); }
  #insPlusView .ip-apply.on { background: var(--indigo); color: #fff; }
  #insPlusView .ip-empty { padding: 26px 0; text-align: center; color: var(--muted); }
  /* performance */
  #insPlusView .ip-kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 10px; margin: 0 0 14px; }
  #insPlusView .ip-kpi { font: inherit; text-align: left; color: inherit; background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 12px 14px; cursor: pointer; }
  #insPlusView .ip-kpi:hover, #insPlusView .ip-kpi.on { border-color: var(--indigo); }
  #insPlusView .ip-kpi .n { font-size: 24px; font-weight: 700; line-height: 1.15; }
  #insPlusView .ip-kpi .l { font-size: 12px; color: var(--muted); margin-top: 2px; }
  #insPlusView .ip-kpi .s { font-size: 11px; color: var(--muted); margin-top: 6px; }
  #insPlusView .ip-kpi .go { font-size: 11px; color: var(--indigo); margin-top: 6px; }
  #insPlusView .ip-grid2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(340px, 1fr)); gap: 14px; margin: 0 0 14px; }
  #insPlusView .ip-grid2 .ip-card { margin: 0; }
  #insPlusView svg { display: block; width: 100%; height: auto; overflow: visible; }
  #insPlusView svg text { fill: var(--muted); font-size: 10px; font-family: inherit; }
  #insPlusView svg .hit { fill: transparent; cursor: pointer; }
  #insPlusView svg .hit:hover, #insPlusView svg .hit.on { fill: rgba(99,102,241,.1); }
  #insPlusView .heat { display: grid; grid-template-columns: 48px repeat(5, 1fr); gap: 3px; font-size: 10.5px; color: var(--muted); }
  #insPlusView .heat .c { height: 18px; border-radius: 4px; background: var(--bg2, rgba(0,0,0,.05)); border: 0; padding: 0; cursor: pointer; }
  #insPlusView .heat .c.on { outline: 2px solid var(--indigo); outline-offset: 1px; }
  #insPlusView .heat .c.h { background: repeating-linear-gradient(45deg, rgba(120,120,120,.2) 0 4px, transparent 4px 8px); cursor: default; }
  #insPlusView .heat .c.fut { background: transparent; border: 1px dashed var(--border); cursor: default; }
  #insPlusView .hbar { display: grid; grid-template-columns: minmax(90px, 170px) minmax(0, 1fr) 90px; gap: 10px; align-items: center; font-size: 12px; padding: 5px 6px; margin: 0 -6px; border-radius: 7px; cursor: pointer; border: 0; background: none; color: inherit; font-family: inherit; width: calc(100% + 12px); text-align: left; }
  #insPlusView .hbar:hover, #insPlusView .hbar.on { background: rgba(99,102,241,.08); }
  #insPlusView .hbar .tr { height: 10px; border-radius: 5px; background: var(--bg2, rgba(0,0,0,.05)); overflow: hidden; }
  #insPlusView .hbar .tr i { display: block; height: 100%; background: var(--indigo); border-radius: 5px; }
  #insPlusView .hbar .nm { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  #insPlusView .hbar .r { text-align: right; color: var(--muted); font-size: 11.5px; }
  #insPlusView .ip-drill { margin-top: 12px; border-top: 1px solid var(--border); padding-top: 10px; }
  #insPlusView .ip-drill .dh { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; }
  #insPlusView .ip-drill .dh b { flex: 1; }
  #insPlusView .ip-drill .x { font: inherit; border: 0; background: none; color: var(--muted); cursor: pointer; font-size: 13px; }
  #insPlusView .tapme { font-size: 11px; color: var(--muted); margin: -6px 0 8px; }
  @media (max-width: 700px) { #insPlusView .ip-stats { grid-template-columns: 1fr; } }
  `;
  document.head.appendChild(css);

  // ---------- shared data loading (no spinners after the first time) ----------
  let perf = null, perfLoaded = false, perfAsked = 0, perfErr = "";
  const view = { el: null, sub: "" };
  function repaint() { if (view.el && !view.el.hidden && view.sub) render(view.sub, view.el); }
  function loadPerfStored() {
    if (perfLoaded) return Promise.resolve();
    return chrome.storage.local.get("perfHistory").then((g) => { if (!perf && g && g.perfHistory) perf = g.perfHistory; }).catch(() => {}).then(() => { perfLoaded = true; });
  }
  // Ask the background for history when ours is older than 6 hours (or from an
  // older version without the per-day details). The background checks its own
  // freshness, the ClickUp back-off and runs one build at a time; once a minute
  // at most from here.
  function maybeRefreshPerf(force) {
    const stale = !perf || perf.v !== 2 || Date.now() - (perf.at || 0) > 6 * H;
    if (!force && !stale) return;
    if (Date.now() - perfAsked < 60000) return;
    perfAsked = Date.now();
    send({ type: "PERF_HISTORY", force: !!force }, 90000).then((r) => {
      if (r && r.data) perf = r.data;
      perfErr = r && !r.ok ? (r.error || r.reason || "") : (r && r.error) || "";
      repaint();
    }).catch(() => {});
  }
  try { chrome.storage.onChanged.addListener((ch, area) => { if (area === "local" && ch.perfHistory && ch.perfHistory.newValue) { perf = ch.perfHistory.newValue; repaint(); } }); } catch (e) {}
  // Developers' open "dev" tasks (background PLAN_DEV_TASKS, cached 30 min): each
  // will come back to the tech team as a short review task once it's done.
  let dev = null, devLoaded = false, devAsked = 0;
  function loadDev() {
    if (!devLoaded) {
      devLoaded = true;
      chrome.storage.local.get("devPipeline").then((g) => { if (!dev && g && g.devPipeline) { dev = g.devPipeline; repaint(); } }).catch(() => {});
    }
    if (Date.now() - devAsked < 60000) return;
    if (dev && Date.now() - (dev.at || 0) < 30 * MIN) return;
    devAsked = Date.now();
    send({ type: "PLAN_DEV_TASKS" }, 60000).then((r) => { if (r && r.data) { dev = r.data; repaint(); } }).catch(() => {});
  }
  try { chrome.storage.onChanged.addListener((ch, area) => { if (area === "local" && ch.devPipeline && ch.devPipeline.newValue) { dev = ch.devPipeline.newValue; repaint(); } }); } catch (e) {}
  // How long a review usually takes you: the median of your finished review
  // tasks (10 min - 1 h), else 30 minutes.
  const REVIEW_RE = /\breview/i;
  function reviewTime() {
    const xs = (perf && Array.isArray(perf.done) ? perf.done : []).filter((t) => REVIEW_RE.test(t.name || "") && Number(t.spentMs) >= 3 * MIN).map((t) => Number(t.spentMs));
    if (xs.length >= 2) {
      const m = Math.min(H, Math.max(10 * MIN, Math.round(median(xs) / (5 * MIN)) * 5 * MIN));
      return { ms: m, why: "your last " + xs.length + " review tasks took about " + fmt(m) };
    }
    return { ms: 30 * MIN, why: "a review usually takes 10 min - 1 h (no finished review tasks to learn from yet)" };
  }
  function needOpenTasks() {
    // Same stored copy and throttle as Health (options.js), so switching sub-tabs never re-fetches.
    if (openRows()) return;
    try {
      insHydrate().then(() => {
        if (openRows()) { repaint(); return; }
        if (!insLoading && Date.now() - insLastAuto > 60000) { insLastAuto = Date.now(); insFetchOpen(false); }
      });
    } catch (e) {}
  }

  // ---------- estimate suggestions from history ----------
  const STOP = new Set(["the", "and", "for", "with", "from", "into", "page", "pages", "task", "tasks", "fix", "add", "update", "check", "make", "new", "all", "this", "that", "only", "then", "its", "per", "via", "not", "are", "has", "have"]);
  const CODE_RE = /\b[A-Z]{2,6}-\d{1,4}(?:\.[A-Z]{0,2}\d{1,3})?\b/g;
  function words(name) {
    return [...new Set(String(name || "").replace(CODE_RE, " ").toLowerCase().replace(/[^a-z0-9]+/g, " ").split(" ").filter((w) => w.length >= 3 && !STOP.has(w) && !/^\d+$/.test(w)))];
  }
  function similarity(a, b) {
    if (!a.length || !b.length) return 0;
    const sb = new Set(b);
    let shared = 0;
    for (const w of a) if (sb.has(w)) shared++;
    if (shared < Math.min(2, a.length, b.length)) return 0;
    return shared / (a.length + b.length - shared);
  }
  const median = (xs) => { const s = xs.slice().sort((x, y) => x - y); const n = s.length; return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : 0; };
  let histIndex = null, histAt = -1, histRows = null;
  function history() {
    const rows = openRows();
    if (histIndex && histAt === (perf && perf.at) && histRows === rows) return histIndex;
    const done = perf && Array.isArray(perf.done) ? perf.done : [];
    const took = done.filter((t) => Number(t.spentMs) >= 5 * MIN).map((t) => ({ id: t.id, name: t.name, w: words(t.name), ms: Number(t.spentMs) }));
    // How similar tasks were ESTIMATED (finished and open ones) - the fallback
    // when nobody tracked time on the similar finished ones.
    const est = done.concat(rows || []).filter((t) => Number(t.estimateMs) > 0).map((t) => ({ id: String(t.id), name: t.name, w: words(t.name), ms: Number(t.estimateMs) }));
    histIndex = { took, est, typical: median(took.map((r) => r.ms)) };
    histAt = perf && perf.at; histRows = rows;
    return histIndex;
  }
  function similarTo(task, list) {
    const w = words(task.name);
    return list.filter((r) => task.id == null || String(r.id) !== String(task.id)).map((r) => ({ r, s: similarity(w, r.w) })).filter((x) => x.s >= 0.5).sort((a, b) => b.s - a.s).slice(0, 8);
  }
  // { ms, why, sure } - a realistic estimate for a task, with the reason shown.
  function suggest(task) {
    const h = history();
    const spent = Number(task.spentMs) || 0;
    const atLeast = spent ? round15(spent * 1.2) : 0;
    const hits = similarTo(task, h.took);
    if (hits.length >= 2) {
      const m = Math.min(8 * H, round15(median(hits.map((x) => x.r.ms))));
      return { ms: Math.max(m, atLeast), sure: true, why: plural(hits.length, "similar finished task") + " took about " + fmt(m) + " (e.g. “" + hits[0].r.name.slice(0, 60) + "”)" };
    }
    const est = similarTo(task, h.est);
    if (est.length >= 2) {
      const m = Math.min(8 * H, round15(median(est.map((x) => x.r.ms))));
      return { ms: Math.max(m, atLeast), sure: true, why: plural(est.length, "similar task") + " are estimated at about " + fmt(m) + " (e.g. “" + est[0].r.name.slice(0, 60) + "”)" };
    }
    if (spent > 0) return { ms: round15(spent * 1.3), sure: false, why: fmt(spent) + " already tracked on it, so a bit more than that" };
    if (h.typical) return { ms: Math.min(4 * H, round15(h.typical)), sure: false, why: "Rough guess - nothing similar yet; your typical task takes about " + fmt(h.typical) };
    return { ms: H, sure: false, why: "Rough guess - no history yet" };
  }
  // An estimate that's clearly too low next to how long this kind of task took.
  function raiseFor(task) {
    const est = Number(task.estimateMs) || 0, spent = Number(task.spentMs) || 0;
    if (!est) return null;
    if (spent > est) return { ms: round15(spent * 1.2), why: "Already " + fmt(spent) + " tracked - more than its " + fmt(est) + " estimate" };
    const hits = similarTo(task, history().took);
    if (hits.length >= 2) {
      const m = round15(median(hits.map((x) => x.r.ms)));
      if (m >= est * 1.5 && m - est >= 30 * MIN) return { ms: m, why: plural(hits.length, "similar finished task") + " took about " + fmt(m) };
    }
    return null;
  }

  // ---------- ordering: dependencies, audit sequence, deadlines ----------
  const PRIO = { urgent: 0, high: 1, normal: 2, low: 3 };
  function codeParts(name) {
    const m = /\b([A-Z]{2,6}-\d{1,4})(?:\.([A-Z]{0,2})(\d{1,3}))?\b/.exec(String(name || ""));
    return m ? { base: m[1], step: m[3] != null ? Number(m[3]) : 0 } : null;
  }
  function orderTasks(items, today) {
    const byId = new Map(items.map((t) => [String(t.id), t]));
    const after = new Map(items.map((t) => [String(t.id), new Set()])); // id -> must come after these
    for (const t of items) {
      for (const d of t.dependsOn || []) if (byId.has(String(d)) && String(d) !== String(t.id)) after.get(String(t.id)).add(String(d));
    }
    // Audit steps of the same item (ACT-066.S2 before ACT-066.S3).
    const groups = new Map();
    for (const t of items) { const c = codeParts(t.name); if (c && c.step) { if (!groups.has(c.base)) groups.set(c.base, []); groups.get(c.base).push({ t, step: c.step }); } }
    for (const list of groups.values()) {
      list.sort((a, b) => a.step - b.step);
      for (let i = 1; i < list.length; i++) if (list[i].step > list[i - 1].step) after.get(String(list[i].t.id)).add(String(list[i - 1].t.id));
    }
    const key = (t) => [t.blocked ? 1 : 0, t.due && t.due < today ? 0 : 1, t.due || 9e15, PRIO[t.priority] != null ? PRIO[t.priority] : 2, t.name.toLowerCase()];
    const cmp = (a, b) => { const x = key(a), y = key(b); for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1; return 0; };
    const left = new Set(items.map((t) => String(t.id)));
    const out = [];
    while (left.size) {
      let ready = [...left].map((id) => byId.get(id)).filter((t) => [...after.get(String(t.id))].every((d) => !left.has(d)));
      // Only waiting tasks (or nothing) are ready, yet others are stuck: a loop of
      // dependencies. Break it by date order - but a task that waits on a
      // blocked task stays behind it.
      if (!ready.some((t) => !t.blocked)) {
        const stuck = [...left].map((id) => byId.get(id)).filter((t) => !t.blocked && ![...after.get(String(t.id))].some((d) => left.has(d) && byId.get(d).blocked));
        if (stuck.length) ready = stuck;
        else if (!ready.length) ready = [...left].map((id) => byId.get(id));
      }
      ready.sort(cmp);
      const pick = ready[0];
      out.push(pick);
      left.delete(String(pick.id));
    }
    for (const t of out) t.afterNames = [...after.get(String(t.id))].map((d) => byId.get(d) && byId.get(d).name).filter(Boolean);
    return out;
  }

  // ---------- Plan ----------
  let lastPlan = null; // the plan on screen, for "Apply to my task list"
  // That day's tasks (in plan order, with that day's planned time) as task-list rows.
  function applyDay(ts) {
    const p = lastPlan;
    const day = p && p.cal.find((d) => d.ts === ts);
    if (!day || !window.PcmPlanDay) return;
    const cur = window.PcmPlanDay.active() && window.PcmPlanDay.current();
    if (cur && cur.day === ts) { window.PcmPlanDay.clear(); return; }
    const src = new Map((openRows() || []).map((r) => [String(r.id), r]));
    const seen = new Map();
    for (const it of day.items) {
      if (it.t.expected) continue; // not a ClickUp task yet - nothing to start or show
      const id = String(it.t.id);
      if (seen.has(id)) { seen.get(id).planMs += it.ms; continue; }
      const r = src.get(id) || {};
      seen.set(id, { ...r, id, name: it.t.name, url: it.t.url, client: it.t.client || r.client || "", dueDateMs: it.t.due || r.dueDateMs || null, estimateMs: it.t.estimateMs || 0, planMs: it.ms, priority: it.t.priority || r.priority || "" });
    }
    const cfg = (p.cfgTasks || []).map((d) => ({ id: d.id, name: d.name, url: d.url, client: d.client || "", container: d.container, dayEstimateMs: (Number(d.dayEstimateMs) || 0) / Math.max(1, p.workdaysInWeek), status: d.status || "", done: !!d.done }));
    window.PcmPlanDay.apply({ day: ts, label: "plan for " + dDay(ts), rows: [...seen.values()], cfg });
  }
  let planWeek = (() => { const g = new Date().getDay(); return g === 0 || g === 6 ? "next" : "this"; })();
  const planOpen = Object.create(null); // which groups / days the user opened (kept across repaints)
  function buildPlan() {
    const st = state(), rows = openRows();
    if (!rows) return null;
    const now = Date.now(), today = dayStart(now);
    const mon = planWeek === "next" ? addDays(monday(now), 7) : monday(now);
    const fri = addDays(mon, 4), weekEnd = addDays(mon, 5) - 1;
    const daysAll = [0, 1, 2, 3, 4].map((i) => addDays(mon, i));
    const days = daysAll.filter((d) => isWorkday(d) && d >= today);
    const holidays = daysAll.filter((d) => isHoliday(d));
    const tMs = targetMs();
    const bundle = planWeek === "next" ? st.nextWeek : (st.thisWorkweek || st.thisWeek);
    const cfgTasks = (bundle && Array.isArray(bundle.deadlineTasks) ? bundle.deadlineTasks : []).filter((d) => d && d.id);
    const cfgIds = new Set(cfgTasks.map((d) => String(d.id)));
    const workdaysInWeek = daysAll.filter(isWorkday).length || 1;
    const cfgWeekMs = cfgTasks.reduce((a, d) => a + (Number(d.dayEstimateMs) || 0), 0);
    const cfgPerDay = cfgWeekMs / workdaysInWeek;
    const hasKids = new Set(rows.filter((r) => r.parentId).map((r) => String(r.parentId)));
    const waiting = st.waiting || {};
    const items = [], missing = [], withEst = [], raise = [], reviewMine = [], reviewsExpected = [];
    const rv = reviewTime();
    const isDevTask = (r) => Array.isArray(r.tags) && r.tags.some((x) => String(x).toLowerCase() === "dev");
    for (const r of rows) {
      if (!r || r.done || cfgIds.has(String(r.id)) || hasKids.has(String(r.id))) continue;
      const due = Number(r.dueDateMs) || 0;
      if (!due || due > weekEnd) continue; // due this week, or overdue (carried over)
      const w = waiting[r.id];
      const blockedBy = w && Array.isArray(w.blockers) && w.blockers.length ? [...new Set(w.blockers.map((b) => b.who || b.name).filter(Boolean))] : [];
      const t = { id: String(r.id), name: r.name || "(untitled task)", url: r.url || taskUrl(r.id), client: r.client || "", due,
        estimateMs: Number(r.estimateMs) || 0, spentMs: Number(r.spentMs) || 0, priority: r.priority || "", dependsOn: r.dependsOn || [],
        blocked: blockedBy.length > 0, blockedBy, overdue: due < today };
      // A developer's task I'm also on: my part is the review afterwards, not
      // its whole estimate (a 35h dev task shared with me made the week 61h).
      if (isDevTask(r) && Number(r.assigneeCount) > 1) {
        t.reviewOnly = true; t.planMs = rv.ms; t.why = "dev task shared with a developer - counted as your review (" + rv.why + "), not its " + (t.estimateMs ? fmt(t.estimateMs) : "full") + " estimate";
        reviewMine.push(t); items.push(t); continue;
      }
      if (!t.estimateMs) { const s = suggest(t); t.planMs = s.ms; t.suggested = s; missing.push(t); }
      else {
        t.planMs = Math.max(15 * MIN, t.estimateMs - t.spentMs);
        withEst.push(t);
        const up = raiseFor(t);
        if (up) { t.raise = up; raise.push(t); }
      }
      items.push(t);
    }
    // Reviews still to come: each open dev task a developer will finish by the end
    // of this week turns into a short review for you. Only clients you work on,
    // and not when the review task already exists in your list (same audit code,
    // or a "review" task with a similar name).
    const myClients = new Set(rows.map((r) => r && r.client).concat((perf && perf.done || []).map((t) => t.client)).filter(Boolean));
    const myReviews = rows.filter((r) => r && !r.done && REVIEW_RE.test(r.name || ""));
    const codeOf = (n) => { const c = codeParts(n); return c ? c.base : ""; };
    const covered = (d) => myReviews.some((r) => (codeOf(d.name) && codeOf(r.name) === codeOf(d.name)) || similarity(words(d.name), words(r.name)) >= 0.5);
    for (const d of (dev && Array.isArray(dev.tasks) ? dev.tasks : [])) {
      const due = Number(d.dueDateMs) || 0;
      if (!due || due > weekEnd || !d.client || !myClients.has(d.client) || covered(d) || items.some((x) => x.id === String(d.id))) continue;
      const t = { id: "rev-" + d.id, devId: String(d.id), name: "Review: " + d.name, url: d.url || taskUrl(d.id), client: d.client, due: Math.max(due, today),
        estimateMs: 0, spentMs: 0, priority: "", dependsOn: [], blocked: false, blockedBy: [], overdue: false, expected: true,
        notBefore: dayStart(Math.max(due, today)), planMs: rv.ms, devBy: (d.assignees || []).slice(0, 2).join(", "),
        why: "expected once " + ((d.assignees || [])[0] || "the developer") + " finishes it (due " + dShort(due) + ") - " + rv.why };
      reviewsExpected.push(t);
      items.push(t);
    }
    const ordered = orderTasks(items, today);
    ordered.forEach((t, i) => { t.no = i + 1; });
    // Fill the days: each working day holds the daily target minus the configured share.
    const cal = days.map((d) => {
      let cap = Math.max(0, tMs - cfgPerDay);
      if (d === today) cap = Math.max(0, cap - (Number(st.spentMs) || 0));
      return { ts: d, cap, left: cap, items: [] };
    });
    const overflow = [];
    for (const t of ordered) {
      let rem = t.planMs;
      let di = 0;
      while (rem > 0) {
        // A review can't happen before the developer's task is due.
        while (di < cal.length && (cal[di].left < 10 * MIN || (t.notBefore && cal[di].ts < t.notBefore))) di++;
        if (di >= cal.length) { overflow.push({ t, ms: rem, part: rem !== t.planMs }); break; }
        const take = Math.min(rem, cal[di].left);
        cal[di].items.push({ t, ms: take, cont: rem !== t.planMs });
        cal[di].left -= take;
        rem -= take;
      }
    }
    const capacityMs = days.length * tMs - (days.includes(today) ? Math.min(tMs, Number(st.spentMs) || 0) : 0);
    const cfgMs = cfgPerDay * days.length;
    const estMs = withEst.reduce((a, t) => a + t.planMs, 0);
    const sugMs = missing.reduce((a, t) => a + t.planMs, 0);
    const revMs = reviewMine.concat(reviewsExpected).reduce((a, t) => a + t.planMs, 0);
    const plannedMs = cfgMs + estMs + sugMs + revMs;
    const fitsMs = cal.reduce((a, d) => a + (d.cap - d.left), 0);
    const overMs = overflow.reduce((a, x) => a + x.ms, 0);
    // Not enough real work for the week: tasks due later that could start now.
    const pull = [];
    if (plannedMs < capacityMs * 0.9) {
      let gap = capacityMs - plannedMs;
      const later = rows.filter((r) => r && !r.done && !cfgIds.has(String(r.id)) && !hasKids.has(String(r.id)) && (!r.dueDateMs || Number(r.dueDateMs) > weekEnd) && !(waiting[r.id] && waiting[r.id].blockers && waiting[r.id].blockers.length))
        .sort((a, b) => (Number(a.dueDateMs) || 9e15) - (Number(b.dueDateMs) || 9e15));
      for (const r of later) {
        if (gap <= 0 || pull.length >= 8) break;
        const t = { id: String(r.id), name: r.name || "(untitled task)", url: r.url || taskUrl(r.id), client: r.client || "", due: Number(r.dueDateMs) || 0, estimateMs: Number(r.estimateMs) || 0, spentMs: Number(r.spentMs) || 0 };
        const ms = t.estimateMs ? Math.max(15 * MIN, t.estimateMs - t.spentMs) : suggest(t).ms;
        pull.push({ t, ms, guessed: !t.estimateMs });
        gap -= ms;
      }
    }
    return { mon, fri, days, holidays, cal, overflow, items, ordered, missing, withEst, raise, pull, cfgTasks, cfgPerDay, capacityMs, cfgMs, estMs, sugMs, revMs, reviewMine, reviewsExpected, rv, plannedMs, fitsMs, overMs, tMs, today, workdaysInWeek };
  }
  // One task line: number · name (one line, full name on hover) · details · time.
  function taskRow(t, timeHtml, opt) {
    const o = opt || {};
    const bits = [];
    if (t.client) bits.push(esc(t.client));
    if (t.due) bits.push(t.overdue ? '<span class="flag bad">Overdue since ' + esc(dShort(t.due)) + "</span>" : "Due " + esc(dShort(t.due)));
    if (t.blocked) bits.push('<span class="flag warn">Waiting on ' + esc(t.blockedBy.slice(0, 2).join(", ")) + "</span>");
    if (o.late) bits.push('<span class="flag bad">Won\'t fit before ' + esc(dShort(t.due)) + "</span>");
    if (o.after && t.afterNames && t.afterNames.length) bits.push('<span class="flag mut" title="' + esc(t.afterNames.join("\n")) + '">After ' + esc(t.afterNames[0].slice(0, 28)) + (t.afterNames.length > 1 ? " +" + (t.afterNames.length - 1) : "") + "</span>");
    if (o.why) bits.push('<span title="' + esc(o.why) + '">' + esc(o.why.length > 90 ? o.why.slice(0, 88) + "…" : o.why) + "</span>");
    return '<div class="ip-row"><span class="no">' + esc(o.no != null ? o.no : "") + '</span><div class="nm"><a href="' + esc(t.url || taskUrl(t.id)) + '" target="_blank" rel="noopener" title="' + esc(t.name) + '">' + esc(t.name) + "</a>" +
      (bits.length ? '<div class="sub">' + bits.join('<span aria-hidden="true">·</span>') + "</div>" : "") + '</div><span class="tm">' + timeHtml + "</span></div>";
  }
  function grp(id, color, title, total, body, openByDefault) {
    const open = planOpen[id] != null ? planOpen[id] : !!openByDefault;
    return '<details class="ip-grp" data-grp="' + esc(id) + '"' + (open ? " open" : "") + "><summary>" + (color ? '<span class="dot" style="--c:' + color + '"></span>' : "") + "<span>" + title + '</span><span class="sp"></span><span class="tot">' + total + '</span></summary><div class="body">' + body + "</div></details>";
  }
  function renderPlan(el) {
    const head = '<div class="ip-head"><h2>Plan</h2><span class="sp"></span>' +
      '<span class="ip-seg"><button type="button" data-week="this" class="' + (planWeek === "this" ? "on" : "") + '">This week</button><button type="button" data-week="next" class="' + (planWeek === "next" ? "on" : "") + '">Next week</button></span></div>' +
      '<p class="ip-sub">How much work is due in the week against your target, what that total is made of, and an order for each day that respects dependencies. Nothing is changed in ClickUp.</p>';
    if (!openRows()) { el.innerHTML = head + '<div class="ip-empty">Loading your open tasks (first time only)…</div>'; wire(el); return; }
    const p = buildPlan();
    if (!p.days.length) { el.innerHTML = head + '<div class="ip-card"><h3>No working days left ' + (planWeek === "this" ? "this week" : "that week") + '</h3><p class="hint">' + (p.holidays.length ? "Company holidays: " + p.holidays.map(dShort).join(", ") + ". " : "") + 'Switch to <b>Next week</b> to plan ahead.</p></div>'; wire(el); return; }
    const diff = p.plannedMs - p.capacityMs;
    const status = Math.abs(diff) <= p.capacityMs * 0.1 ? { cls: "good", k: "On target", v: diff >= 0 ? "+" + fmt(diff) : "−" + fmt(-diff) }
      : diff < 0 ? { cls: "warn", k: "Short by", v: fmt(-diff) } : { cls: "bad", k: "Over by", v: fmt(diff) };
    const scale = Math.max(p.plannedMs, p.capacityMs) || 1;
    const pc = (ms) => (ms / scale) * 100;
    const range = dShort(p.mon) + " – " + dShort(p.fri);
    const daysTxt = p.days.length + " working day" + (p.days.length === 1 ? "" : "s") + (planWeek === "this" ? " left" : "") + " × " + fmt(p.tMs) + (p.holidays.length ? " · holidays left out" : "");
    let h = head;
    // 1) Summary
    h += '<div class="ip-card"><div class="ip-head"><h3>' + (planWeek === "this" ? "This week" : "Next week") + " · " + esc(range) + "</h3></div>" +
      '<div class="ip-stats"><div class="ip-stat"><div class="k">Target</div><div class="v">' + fmt(p.capacityMs) + '</div><div class="s">' + esc(daysTxt) + "</div></div>" +
      '<div class="ip-stat"><div class="k">Planned</div><div class="v">' + fmt(p.plannedMs) + '</div><div class="s">' + plural(p.items.length, "task") + " due" + (p.cfgMs ? " + Extra Task share" : "") + " · breakdown below</div></div>" +
      '<div class="ip-stat ' + status.cls + '"><div class="k">' + status.k + '</div><div class="v">' + status.v + '</div><div class="s">' + (status.cls === "bad" ? fmt(p.overMs) + " doesn't fit the days below" : status.cls === "warn" ? "see “To fill the week”" : "a full, realistic week") + "</div></div></div>" +
      '<div class="ip-bar"><i class="cfg" style="left:0;width:' + pc(p.cfgMs) + '%"></i><i class="est" style="left:' + pc(p.cfgMs) + "%;width:" + pc(p.estMs) + '%"></i><i class="sug" style="left:' + pc(p.cfgMs + p.estMs) + "%;width:" + pc(p.sugMs) + '%"></i><i class="rev" style="left:' + pc(p.cfgMs + p.estMs + p.sugMs) + "%;width:" + pc(p.revMs) + '%"></i>' +
      '<b style="left:' + Math.min(99.6, pc(p.capacityMs)) + '%"><span>' + fmt(p.capacityMs) + " target</span></b></div>" +
      '<div class="ip-legend"><span style="--c:var(--indigo)">Extra Task share ' + fmt(p.cfgMs) + '</span><span style="--c:var(--amber)">Estimated ' + fmt(p.estMs) + '</span><span style="--c:rgba(217,119,6,.45)">Suggested ' + fmt(p.sugMs) + "</span>" + (p.revMs ? '<span style="--c:#0d9488">Reviews ' + fmt(p.revMs) + "</span>" : "") + "</div></div>";
    // 2) What the planned total is made of
    let b = "";
    if (p.cfgTasks.length) {
      b += grp("cfg", "var(--indigo)", "Extra Task share", fmt(p.cfgMs),
        p.cfgTasks.map((d) => taskRow({ id: d.id, name: d.name || "Configured task", url: d.url, client: d.client || "" }, fmt((Number(d.dayEstimateMs) || 0) * p.days.length / p.workdaysInWeek), { why: fmt((Number(d.dayEstimateMs) || 0) / p.workdaysInWeek) + " a working day" })).join(""));
    }
    if (p.withEst.length) {
      const list = p.withEst.slice().sort((a, b2) => b2.planMs - a.planMs);
      b += grp("est", "var(--amber)", "Tasks with an estimate · " + p.withEst.length, fmt(p.estMs),
        list.map((t) => taskRow(t, fmt(t.planMs) + (t.spentMs ? "<small>" + fmt(t.estimateMs) + " − " + fmt(t.spentMs) + " done</small>" : ""), { no: t.no })).join(""));
    }
    if (p.missing.length) {
      b += grp("sug", "rgba(217,119,6,.5)", "Tasks without an estimate · " + p.missing.length + " (suggested)", fmt(p.sugMs),
        p.missing.slice().sort((a, b2) => b2.planMs - a.planMs).map((t) => taskRow(t, fmt(t.planMs) + (t.suggested.sure ? "" : "<small>rough</small>"), { no: t.no, why: t.suggested.why })).join(""));
    }
    if (p.reviewMine.length) {
      b += grp("revmine", "#0d9488", "Your part: reviews of developers' tasks · " + p.reviewMine.length, fmt(p.reviewMine.reduce((a, t) => a + t.planMs, 0)),
        p.reviewMine.map((t) => taskRow(t, fmt(t.planMs) + (t.estimateMs ? "<small>task est " + fmt(t.estimateMs) + "</small>" : ""), { no: t.no, why: t.why })).join(""), true);
    }
    if (p.reviewsExpected.length) {
      b += grp("revexp", "#0d9488", "Expected reviews · " + p.reviewsExpected.length + " (not created yet)", fmt(p.reviewsExpected.reduce((a, t) => a + t.planMs, 0)),
        p.reviewsExpected.map((t) => taskRow(t, fmt(t.planMs) + "<small>expected</small>", { no: t.no, why: t.why })).join(""));
    }
    h += '<div class="ip-card"><h3>What makes up the ' + fmt(p.plannedMs) + '</h3><p class="hint">Every task due ' + (planWeek === "this" ? "by Friday" : "that week") + ", overdue ones included (they carry over). Time = estimate minus what's already tracked. Tasks without an estimate get a suggested time based on how long similar tasks took. Developers' dev tasks count as the short review that comes back to you (" + esc(fmt(p.rv.ms)) + " each), not their whole estimate. Open a group to see each task.</p>" +
      b + '<div class="ip-total"><span>Total</span><span>' + fmt(p.plannedMs) + "</span></div></div>";
    // 3) Fix it
    if (p.overflow.length) {
      h += '<div class="ip-card"><h3>Doesn\'t fit this week · ' + fmt(p.overMs) + '</h3><p class="hint">The days below hold ' + fmt(p.fitsMs) + " of tasks (" + fmt(Math.max(0, p.tMs - p.cfgPerDay)) + " a day next to the Extra Task). These come last in the order, so they're the ones to move to next week, split, or ask about.</p>" +
        p.overflow.map((x) => taskRow(x.t, fmt(x.ms) + (x.part ? "<small>the rest of it</small>" : ""), { no: x.t.no })).join("") + "</div>";
    }
    if (p.pull.length) {
      h += '<div class="ip-card"><h3>To fill the week, start these early</h3><p class="hint">Real work due later (or with no due date) that isn\'t waiting on anyone - better than raising estimates to reach the target.</p>' +
        p.pull.map((x) => taskRow(x.t, fmt(x.ms) + (x.guessed ? "<small>suggested</small>" : ""), {})).join("") + "</div>";
    }
    if (p.raise.length) {
      h += '<div class="ip-card"><h3>Estimates that look too low</h3><p class="hint">Not changed in the totals above - just worth a look.</p>' +
        p.raise.map((t) => taskRow(t, fmt(t.raise.ms) + "<small>now " + fmt(t.estimateMs) + "</small>", { why: t.raise.why })).join("") + "</div>";
    }
    // 4) Day by day
    let d = "";
    for (const day of p.cal) {
      const used = day.cap - day.left;
      const tasksN = new Set(day.items.map((it) => it.t.id)).size;
      const body = day.items.length ? day.items.map((it) => taskRow(it.t, fmt(it.ms) + (it.cont ? "<small>continued</small>" : ""), { no: it.cont ? "↳" : it.t.no, after: !it.cont, late: !it.t.overdue && it.t.due && day.ts > dayStart(it.t.due) })).join("") : '<p class="ip-meta" style="margin:8px 0">Nothing planned - room for more.</p>';
      const cur = window.PcmPlanDay && window.PcmPlanDay.active() && window.PcmPlanDay.current();
      const applied = !!(cur && cur.day === day.ts);
      const applyBtn = day.items.length ? '<button type="button" class="ip-btn ip-apply' + (applied ? " on" : "") + '" data-apply-day="' + day.ts + '" title="' + (applied ? "Showing this day in your task list - click to go back to your filter" : "Show exactly these tasks, in this order, in the task list on the dashboard, popup and side panel (nothing changes in ClickUp)") + '">' + (applied ? "Applied ✓" : "Apply to my task list") + "</button>" : "";
      d += grp("day" + day.ts, "", esc(dDay(day.ts)) + (day.ts === p.today ? " · today" : "") + ' <span class="ip-meta" style="font-weight:400">· ' + plural(tasksN, "task") + "</span>",
        applyBtn + ' <span class="ip-daybar" title="' + fmt(used) + " of " + fmt(day.cap) + '"><i style="width:' + Math.round((used / Math.max(1, day.cap)) * 100) + '%"></i></span> ' + fmt(used), body, day === p.cal[0]);
    }
    lastPlan = p;
    h += '<div class="ip-card"><h3>Day by day</h3><p class="hint">Each day is filled up to ' + fmt(Math.max(0, p.tMs - p.cfgPerDay)) + " of tasks" + (p.cfgPerDay ? " (+ " + fmt(p.cfgPerDay) + " Extra Task)" : "") + ". Order: what a task depends on comes first (ClickUp dependencies, earlier steps of the same audit item like ACT-066.S2 before .S3), then overdue, then by due date and priority; tasks waiting on someone go last.</p>" + d + "</div>";
    h += '<p class="ip-meta">Tasks from ' + (typeof insCache !== "undefined" && insCache && insCache.at ? ago(insCache.at) : "—") + (perf ? " · history from " + ago(perf.at) : "") + ".</p>";
    el.innerHTML = h;
    wire(el);
  }

  // ---------- Performance ----------
  let drill = null; // { card, kind, key } - which detail list is open
  function nameOf(id) {
    id = String(id);
    if (perf && perf.names && perf.names[id]) return perf.names[id];
    const d = perf && (perf.done || []).find((t) => String(t.id) === id);
    if (d) return d.name;
    const o = (openRows() || []).find((t) => String(t.id) === id);
    return o ? o.name : "(task " + id + ")";
  }
  function dayTasks(ts) {
    const m = (perf && perf.byDay && (perf.byDay[ts] || perf.byDay[String(ts)])) || {};
    return Object.entries(m).map(([id, ms]) => ({ id, name: nameOf(id), ms })).sort((a, b) => b.ms - a.ms);
  }
  function weekTasks(mon) {
    const acc = new Map();
    for (let i = 0; i < 7; i++) for (const t of dayTasks(addDays(mon, i))) acc.set(t.id, { id: t.id, name: t.name, ms: (acc.has(t.id) ? acc.get(t.id).ms : 0) + t.ms });
    return [...acc.values()].sort((a, b) => b.ms - a.ms);
  }
  const simpleRows = (list, timeOf, subOf) => list.length ? list.map((t, i) => '<div class="ip-row"><span class="no">' + (i + 1) + '</span><div class="nm"><a href="' + esc(t.url || taskUrl(t.id)) + '" target="_blank" rel="noopener" title="' + esc(t.name) + '">' + esc(t.name) + "</a>" + (subOf ? '<div class="sub">' + subOf(t) + "</div>" : "") + '</div><span class="tm">' + timeOf(t) + "</span></div>").join("") : '<p class="ip-meta">Nothing here.</p>';
  function svgBars(vals, opt) {
    const W = 560, Hh = opt.h || 150, pad = 22, n = vals.length || 1, bw = (W - 10) / n;
    const max = Math.max(1, opt.max || 0, ...vals.map((v) => Math.max(v.line || 0, (Array.isArray(v.parts) ? v.parts.reduce((a, b) => a + b, 0) : v.v) || 0)));
    let s = '<svg viewBox="0 0 ' + W + " " + (Hh + pad) + '" role="img" aria-label="' + esc(opt.label || "") + '">';
    vals.forEach((v, i) => {
      const x0 = 5 + i * bw, x = x0 + bw * 0.18, w = bw * 0.64;
      const on = drill && drill.card === opt.card && String(drill.key) === String(v.key);
      s += '<rect class="hit' + (on ? " on" : "") + '" x="' + x0.toFixed(1) + '" y="0" width="' + bw.toFixed(1) + '" height="' + (Hh + pad) + '" rx="4" data-card="' + opt.card + '" data-kind="' + opt.kind + '" data-key="' + esc(v.key) + '"><title>' + esc((v.tip || "") + " - click for details") + "</title></rect>";
      const parts = Array.isArray(v.parts) ? v.parts : [v.v || 0];
      let y = Hh;
      parts.forEach((pv, k) => {
        const hgt = Math.round((pv / max) * (Hh - 8));
        if (hgt > 0) { y -= hgt; s += '<rect pointer-events="none" x="' + x.toFixed(1) + '" y="' + y + '" width="' + w.toFixed(1) + '" height="' + hgt + '" rx="3" fill="' + ((opt.colors && opt.colors[k]) || v.color || "var(--indigo)") + '"/>'; }
      });
      if (v.lbl != null) s += '<text pointer-events="none" x="' + (x + w / 2).toFixed(1) + '" y="' + (Hh + 14) + '" text-anchor="middle">' + esc(v.lbl) + "</text>";
      if (v.line) { const ly = Hh - Math.round((v.line / max) * (Hh - 8)); s += '<line pointer-events="none" x1="' + (x - 3).toFixed(1) + '" x2="' + (x + w + 3).toFixed(1) + '" y1="' + ly + '" y2="' + ly + '" stroke="var(--text)" stroke-opacity=".55" stroke-width="2" stroke-dasharray="4 3"/>'; }
    });
    return s + "</svg>";
  }
  function heatColor(ratio) {
    if (ratio >= 0.98) return "rgba(22,163,74," + Math.min(0.95, 0.45 + (ratio - 0.98) * 1.5) + ")";
    if (ratio >= 0.7) return "rgba(217,119,6,.55)";
    if (ratio > 0) return "rgba(220,38,38,.45)";
    return "rgba(220,38,38,.18)";
  }
  function drillBox(card, title, body) {
    if (!drill || drill.card !== card) return "";
    return '<div class="ip-drill"><div class="dh"><b>' + title + '</b><button type="button" class="x" data-close-drill="1" title="Close">✕</button></div>' + body + "</div>";
  }
  function renderPerf(el) {
    const head = '<div class="ip-head"><h2>Performance</h2><span class="sp"></span><button type="button" class="ip-btn" data-perf-refresh="1" title="Read your history from ClickUp again (at most every 10 minutes)">↻ Refresh</button></div>' +
      '<p class="ip-sub">Only you see this: your own tracked time, deadlines and workload over the last ' + ((perf && perf.weeks) || 12) + " weeks. Weekends and company holidays don't count against you. Click any number, bar or day to see what's behind it.</p>";
    if (!perf) { el.innerHTML = head + '<div class="ip-empty">' + (perfErr ? "Couldn't read your history: " + esc(perfErr) : "Reading your last 12 weeks from ClickUp (first time only, one short read)…") + "</div>"; wire(el); return; }
    const tMs = targetMs(), today = dayStart(Date.now());
    const weeks = [];
    const firstMon = monday(perf.fromTs);
    for (let w = 0; w < (perf.weeks || 12); w++) {
      const mon = addDays(firstMon, 7 * w);
      if (mon > today) break;
      const days = [0, 1, 2, 3, 4].map((i) => addDays(mon, i));
      const work = days.filter(isWorkday);
      let tracked = 0;
      for (let i = 0; i < 7; i++) tracked += Number(perf.days[addDays(mon, i)]) || 0;
      weeks.push({ mon, days, work, tracked, target: work.length * tMs });
    }
    const pastWork = [];
    for (const w of weeks) for (const d of w.work) if (d < today) pastWork.push({ d, ms: Number(perf.days[d]) || 0 });
    const recent = pastWork.filter((x) => x.d >= addDays(today, -28));
    const onT = (xs) => xs.filter((x) => x.ms >= tMs * 0.98).length;
    const avg = (xs) => xs.length ? xs.reduce((a, x) => a + x.ms, 0) / xs.length : 0;
    const done = (perf.done || []).filter((t) => t.doneAt);
    const dated = done.filter((t) => t.dueDateMs > 0);
    const late = (t) => t.doneAt > dayStart(t.dueDateMs) + DAY - 1;
    const daysLate = (t) => Math.max(1, Math.ceil((t.doneAt - (dayStart(t.dueDateMs) + DAY)) / DAY));
    const dRecent = dated.filter((t) => t.doneAt >= addDays(today, -28));
    const onTimePct = (xs) => xs.length ? Math.round((xs.filter((t) => !late(t)).length / xs.length) * 100) : null;
    const acc = done.filter((t) => t.estimateMs > 0 && t.spentMs > 0);
    const ratios = acc.map((t) => t.spentMs / t.estimateMs);
    const medRatio = median(ratios);
    const within = ratios.length ? Math.round((ratios.filter((r) => r >= 0.75 && r <= 1.25).length / ratios.length) * 100) : null;
    const rows = openRows() || [];
    const hasKids = new Set(rows.filter((r) => r.parentId).map((r) => String(r.parentId)));
    const thisMon = monday(Date.now());
    const ahead = [0, 1, 2].map((k) => {
      const mon = addDays(thisMon, 7 * k), end = addDays(mon, 7) - 1;
      const work = [0, 1, 2, 3, 4].map((i) => addDays(mon, i)).filter(isWorkday);
      const due = rows.filter((r) => !hasKids.has(String(r.id)) && Number(r.dueDateMs) > 0 && Number(r.dueDateMs) >= (k === 0 ? 0 : mon) && Number(r.dueDateMs) <= end);
      const est = due.reduce((a, r) => a + Math.max(0, (Number(r.estimateMs) || 0) - (Number(r.spentMs) || 0)), 0);
      return { mon, due, n: due.length, est, cap: work.length * tMs, noEst: due.filter((r) => !Number(r.estimateMs)).length };
    });
    const clientOf = new Map();
    for (const t of perf.done || []) if (t.client) clientOf.set(String(t.id), t.client);
    for (const r of rows) if (r.client) clientOf.set(String(r.id), r.client);
    const byClient = new Map();
    for (const [tid, ms] of Object.entries(perf.taskMs || {})) { const c = clientOf.get(String(tid)) || "Other"; byClient.set(c, (byClient.get(c) || 0) + ms); }
    const top = [...byClient.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
    const hasDetail = perf.v === 2;
    const needNew = '<p class="ip-meta">Task-level details arrive with the next history refresh (a few seconds).</p>';

    const kpi = (id, n, l, s, cls) => '<button type="button" class="ip-kpi' + (drill && drill.card === "kpi" && drill.key === id ? " on" : "") + '" data-card="kpi" data-kind="kpi" data-key="' + id + '"><div class="n"' + (cls ? ' style="color:var(--' + (cls === "good" ? "green" : cls === "bad" ? "red" : "amber") + ')"' : "") + ">" + esc(n) + '</div><div class="l">' + esc(l) + "</div>" + (s ? '<div class="s">' + esc(s) + "</div>" : "") + '<div class="go">Details →</div></button>';
    const rDays = recent.length, rOn = onT(recent);
    let h = head;
    h += '<div class="ip-kpis">' +
      kpi("days", rDays ? rOn + " / " + rDays : "—", "days at " + fmt(tMs) + "+ (last 4 weeks)", pastWork.length ? onT(pastWork) + " of " + pastWork.length + " over " + weeks.length + " weeks" : "", rDays ? (rOn / rDays >= 0.8 ? "good" : "warn") : "") +
      kpi("avg", fmt(avg(recent)), "average per working day (4 weeks)", weeks.length + "-week average " + fmt(avg(pastWork))) +
      kpi("deadlines", onTimePct(dRecent) == null ? "—" : onTimePct(dRecent) + "%", "deadlines met (4 weeks)", plural(dRecent.length, "finished task") + " with a due date", onTimePct(dRecent) == null ? "" : onTimePct(dRecent) >= 85 ? "good" : onTimePct(dRecent) >= 65 ? "warn" : "bad") +
      kpi("accuracy", ratios.length ? "×" + (Math.round(medRatio * 100) / 100) : "—", "time taken vs estimate (median)", ratios.length ? (medRatio > 1.1 ? "usually more than estimated" : medRatio < 0.9 ? "usually less than estimated" : "estimates about right") + " · " + within + "% within ±25%" : "nothing to compare yet", ratios.length ? (medRatio >= 0.85 && medRatio <= 1.2 ? "good" : "warn") : "") +
      "</div>";
    if (drill && drill.card === "kpi") {
      let title = "", body = "";
      if (drill.key === "days" || drill.key === "avg") {
        title = "Your working days, last 4 weeks";
        body = recent.slice().reverse().map((x) => '<div class="ip-row"><span class="no">' + (x.ms >= tMs * 0.98 ? "✓" : "") + '</span><div class="nm"><button type="button" class="ip-btn" data-card="heat" data-kind="day" data-key="' + x.d + '" style="border:0;padding:0;background:none;color:var(--indigo)">' + esc(dDay(x.d)) + '</button></div><span class="tm">' + fmt(x.ms) + "<small>" + (x.ms >= tMs * 0.98 ? "target reached" : fmt(tMs - x.ms) + " short") + "</small></span></div>").join("") || '<p class="ip-meta">No working days yet.</p>';
      } else if (drill.key === "deadlines") {
        title = "Finished tasks with a due date, last 4 weeks";
        body = simpleRows(dRecent.slice().sort((a, b) => b.doneAt - a.doneAt), (t) => late(t) ? '<span class="flag bad">' + daysLate(t) + "d late</span>" : '<span class="flag mut">on time</span>', (t) => (t.client ? esc(t.client) + " · " : "") + "due " + esc(dShort(t.dueDateMs)) + " · done " + esc(dShort(t.doneAt)));
      } else {
        title = "Estimate vs time taken (finished tasks)";
        body = simpleRows(acc.slice().sort((a, b) => b.spentMs / b.estimateMs - a.spentMs / a.estimateMs).slice(0, 40), (t) => fmt(t.spentMs) + "<small>est " + fmt(t.estimateMs) + " · ×" + (Math.round((t.spentMs / t.estimateMs) * 10) / 10) + "</small>", (t) => (t.client ? esc(t.client) + " · " : "") + "done " + esc(dShort(t.doneAt)));
      }
      h += '<div class="ip-card" style="margin-top:-4px">' + drillBox("kpi", title, body) + "</div>";
    }
    h += '<div class="ip-grid2">';
    // Weekly tracked
    let wkDrill = "";
    if (drill && drill.card === "week") {
      const w = weeks.find((x) => String(x.mon) === String(drill.key));
      if (w) {
        const perDay = [0, 1, 2, 3, 4, 5, 6].map((i) => addDays(w.mon, i)).filter((d) => Number(perf.days[d]) > 0 || isWorkday(d));
        wkDrill = drillBox("week", "Week of " + esc(dShort(w.mon)) + " · " + fmt(w.tracked) + " of " + fmt(w.target),
          perDay.map((d) => '<div class="ip-row"><span class="no"></span><div class="nm"><button type="button" class="ip-btn" data-card="heat" data-kind="day" data-key="' + d + '" style="border:0;padding:0;background:none;color:var(--indigo)">' + esc(dDay(d)) + "</button>" + (isHoliday(d) ? ' <span class="flag mut">holiday</span>' : "") + '</div><span class="tm">' + fmt(Number(perf.days[d]) || 0) + "</span></div>").join("") +
          (hasDetail ? '<p class="ip-meta" style="margin:10px 0 2px">Tasks you tracked time on</p>' + simpleRows(weekTasks(w.mon), (t) => fmt(t.ms)) : needNew));
      }
    }
    h += '<div class="ip-card"><h3>Tracked per week</h3><p class="hint">Bars: time you tracked. Dashed line: that week\'s target (working days × ' + fmt(tMs) + ").</p>" +
      svgBars(weeks.map((w) => ({ key: w.mon, v: w.tracked, line: w.target, lbl: dShort(w.mon), color: w.target && w.tracked >= w.target * 0.98 ? "var(--green)" : "var(--indigo)", tip: "Week of " + dShort(w.mon) + ": " + fmt(w.tracked) + " of " + fmt(w.target) })), { card: "week", kind: "week", label: "Tracked per week" }) + wkDrill + "</div>";
    // Heatmap
    let hm = '<div class="heat"><span></span><span>Mon</span><span>Tue</span><span>Wed</span><span>Thu</span><span>Fri</span>';
    for (const w of weeks.slice().reverse()) {
      hm += "<span>" + esc(dShort(w.mon)) + "</span>";
      for (const d of w.days) {
        const ms = Number(perf.days[d]) || 0;
        const on = drill && drill.card === "heat" && String(drill.key) === String(d);
        if (d > today) hm += '<span class="c fut"></span>';
        else if (isHoliday(d)) hm += '<span class="c h" title="' + esc(dDay(d)) + ': company holiday"></span>';
        else hm += '<button type="button" class="c' + (on ? " on" : "") + '" data-card="heat" data-kind="day" data-key="' + d + '" style="background:' + heatColor(d === today ? Math.max(ms / tMs, 0.01) : ms / tMs) + '" title="' + esc(dDay(d)) + ": " + fmt(ms) + (d === today ? " so far" : "") + ' - click for the tasks"></button>';
      }
    }
    hm += "</div>";
    let dayDrill = "";
    if (drill && drill.card === "heat") {
      const d = Number(drill.key);
      dayDrill = drillBox("heat", esc(dDay(d)) + " · " + fmt(Number(perf.days[d]) || 0) + " tracked", hasDetail ? simpleRows(dayTasks(d), (t) => fmt(t.ms)) : needNew);
    }
    h += '<div class="ip-card"><h3>Your ' + fmt(tMs) + ' days</h3><p class="hint">Green: target reached · amber: 70%+ · red: less · striped: holiday. Newest week on top; click a day for its tasks.</p>' + hm + dayDrill + "</div>";
    // Deadlines per week
    const finWeek = (mon) => done.filter((t) => t.doneAt >= mon && t.doneAt < addDays(mon, 7));
    let dlDrill = "";
    if (drill && drill.card === "deadlines") {
      const mon = Number(drill.key), list = finWeek(mon).filter((t) => t.dueDateMs > 0).sort((a, b) => b.doneAt - a.doneAt);
      dlDrill = drillBox("deadlines", "Week of " + esc(dShort(mon)) + " · " + list.filter((t) => !late(t)).length + " on time, " + list.filter(late).length + " late",
        simpleRows(list, (t) => late(t) ? '<span class="flag bad">' + daysLate(t) + "d late</span>" : '<span class="flag mut">on time</span>', (t) => (t.client ? esc(t.client) + " · " : "") + "due " + esc(dShort(t.dueDateMs)) + " · done " + esc(dShort(t.doneAt))));
    }
    h += '<div class="ip-card"><h3>Deadlines met</h3><p class="hint">Finished tasks per week that had a due date: green on time, red late. Click a week for the tasks.</p>' +
      svgBars(weeks.map((w) => { const inW = finWeek(w.mon).filter((t) => t.dueDateMs > 0); const lt = inW.filter(late).length; return { key: w.mon, parts: [inW.length - lt, lt], lbl: dShort(w.mon), tip: "Week of " + dShort(w.mon) + ": " + (inW.length - lt) + " on time, " + lt + " late" }; }), { card: "deadlines", kind: "week", colors: ["var(--green)", "var(--red)"], label: "Deadlines met per week" }) + dlDrill + "</div>";
    // Finished per week
    let fnDrill = "";
    if (drill && drill.card === "finished") {
      const mon = Number(drill.key), list = finWeek(mon).sort((a, b) => b.doneAt - a.doneAt);
      fnDrill = drillBox("finished", "Week of " + esc(dShort(mon)) + " · " + plural(list.length, "task") + " finished",
        simpleRows(list, (t) => t.spentMs ? fmt(t.spentMs) : '<span class="ip-meta">—</span>', (t) => (t.client ? esc(t.client) + " · " : "") + "done " + esc(dDay(t.doneAt))));
    }
    h += '<div class="ip-card"><h3>Tasks finished per week</h3><p class="hint">Everything you closed, with or without a due date. Click a week for the list.</p>' +
      svgBars(weeks.map((w) => { const c = finWeek(w.mon).length; return { key: w.mon, v: c, lbl: dShort(w.mon), tip: c + " finished in the week of " + dShort(w.mon) }; }), { card: "finished", kind: "week", label: "Tasks finished per week" }) + fnDrill + "</div>";
    h += "</div>";
    // Workload ahead
    let wl = "";
    for (const a of ahead) {
      const pc = a.cap ? Math.round((a.est / a.cap) * 100) : 0;
      const cls = pc > 110 ? "var(--red)" : pc >= 80 ? "var(--green)" : "var(--amber)";
      const on = drill && drill.card === "load" && String(drill.key) === String(a.mon);
      wl += '<button type="button" class="hbar' + (on ? " on" : "") + '" data-card="load" data-kind="load" data-key="' + a.mon + '"><span class="nm">' + (a.mon === thisMon ? "This week" : "Week of " + esc(dShort(a.mon))) + '</span><span class="tr"><i style="width:' + Math.min(100, pc) + "%;background:" + cls + '"></i></span><span class="r">' + pc + "% · " + plural(a.n, "task") + "</span></button>" +
        '<div class="ip-meta" style="margin:0 0 6px 0">' + fmt(a.est) + " of " + fmt(a.cap) + (a.noEst ? " · " + a.noEst + " without an estimate (not counted)" : "") + (pc > 110 ? ' · <b style="color:var(--red)">overloaded</b>' : "") + "</div>";
    }
    let ldDrill = "";
    if (drill && drill.card === "load") {
      const a = ahead.find((x) => String(x.mon) === String(drill.key));
      if (a) ldDrill = drillBox("load", (a.mon === thisMon ? "This week (overdue included)" : "Week of " + esc(dShort(a.mon))) + " · " + fmt(a.est) + " left",
        simpleRows(a.due.slice().sort((x, y) => (Number(x.dueDateMs) || 0) - (Number(y.dueDateMs) || 0)).map((r) => ({ id: r.id, name: r.name, url: r.url, client: r.client, due: Number(r.dueDateMs), est: Number(r.estimateMs) || 0, spent: Number(r.spentMs) || 0 })),
          (t) => t.est ? fmt(Math.max(0, t.est - t.spent)) + (t.spent ? "<small>of " + fmt(t.est) + "</small>" : "") : '<span class="flag warn">no estimate</span>', (t) => (t.client ? esc(t.client) + " · " : "") + (t.due < today ? '<span class="flag bad">overdue ' + esc(dShort(t.due)) + "</span>" : "due " + esc(dShort(t.due)))));
    }
    h += '<div class="ip-card"><h3>Workload ahead</h3><p class="hint">Estimated time still left on your open tasks due each week, against what fits in it. Over 110% means overloaded. Click a week for its tasks.</p>' + wl + ldDrill + "</div>";
    // Time by client
    if (top.length) {
      const max = top[0][1];
      let cl = "";
      for (const [c, ms] of top) {
        const on = drill && drill.card === "client" && drill.key === c;
        cl += '<button type="button" class="hbar' + (on ? " on" : "") + '" data-card="client" data-kind="client" data-key="' + esc(c) + '"><span class="nm" title="' + esc(c) + '">' + esc(c) + '</span><span class="tr"><i style="width:' + Math.max(2, Math.round((ms / max) * 100)) + '%"></i></span><span class="r">' + fmt(ms) + "</span></button>";
      }
      let clDrill = "";
      if (drill && drill.card === "client") {
        const list = Object.entries(perf.taskMs || {}).filter(([id]) => (clientOf.get(String(id)) || "Other") === drill.key).map(([id, ms]) => ({ id, name: nameOf(id), ms })).sort((a, b) => b.ms - a.ms);
        clDrill = drillBox("client", esc(drill.key) + " · " + fmt(list.reduce((a, t) => a + t.ms, 0)), simpleRows(list, (t) => fmt(t.ms)));
      }
      h += '<div class="ip-card"><h3>Where your time went</h3><p class="hint">Tracked time per client over the last ' + (perf.weeks || 12) + ' weeks ("Other": tasks no longer in your lists). Click a client for its tasks.</p>' + cl + clDrill + "</div>";
    }
    h += '<p class="ip-meta">History updated ' + ago(perf.at) + " (refreshes by itself every few hours)." + (perfErr ? " Last refresh failed: " + esc(perfErr) : "") + "</p>";
    el.innerHTML = h;
    wire(el);
    // Bring an opened detail into view (it sits under the thing that was clicked).
    if (drill && drill.scroll) { drill.scroll = false; const box = el.querySelector(".ip-drill"); if (box) try { box.scrollIntoView({ block: "nearest", behavior: "smooth" }); } catch (e) {} }
  }

  function wire(el) {
    el.querySelectorAll("[data-week]").forEach((b) => { b.onclick = () => { planWeek = b.getAttribute("data-week"); repaint(); }; });
    el.querySelectorAll("[data-apply-day]").forEach((b) => {
      b.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); applyDay(Number(b.getAttribute("data-apply-day"))); });
    });
    el.querySelectorAll("details.ip-grp").forEach((d) => { d.addEventListener("toggle", () => { planOpen[d.getAttribute("data-grp")] = d.open; }); });
    const r = el.querySelector("[data-perf-refresh]");
    if (r) r.onclick = () => { perfAsked = 0; r.textContent = "Refreshing…"; r.disabled = true; maybeRefreshPerf(true); };
    el.querySelectorAll("[data-card][data-key]").forEach((n) => {
      n.addEventListener("click", (e) => {
        e.preventDefault();
        const card = n.getAttribute("data-card"), key = n.getAttribute("data-key");
        drill = drill && drill.card === card && String(drill.key) === key ? null : { card, kind: n.getAttribute("data-kind"), key, scroll: true };
        repaint();
      });
    });
    el.querySelectorAll("[data-close-drill]").forEach((b) => { b.onclick = () => { drill = null; repaint(); }; });
  }

  function render(sub, el) {
    view.el = el; view.sub = sub;
    needOpenTasks();
    if (sub === "plan") loadDev();
    if (!perfLoaded) { loadPerfStored().then(() => { maybeRefreshPerf(false); repaint(); }); }
    else maybeRefreshPerf(false);
    if (sub === "plan") renderPlan(el);
    else renderPerf(el);
  }
  window.PcmInsightsPlus = { render, _test: { words, similarity, suggest: (t) => suggest(t), orderTasks, codeParts, buildPlan, setPerf: (p) => { perf = p; perfLoaded = true; histIndex = null; } } };
})();
