// "Where does this number come from?" - click the Estimated or Tracked value on
// the Today / filter card (popup, side panel, dashboard) for a small panel that
// lists the tasks behind it and explains the gap between the two numbers:
// time tracked on tasks not due in these dates, time over the estimate, tasks
// with no estimate, and estimated tasks with nothing tracked yet.
(() => {
  "use strict";
  const css = document.createElement("style");
  css.textContent = `
    .pbd { position: fixed; z-index: 3000; width: min(460px, calc(100vw - 16px)); max-height: min(70vh, 560px); overflow: auto; background: var(--card); color: var(--text); border: 1px solid var(--border); border-radius: 12px; box-shadow: 0 16px 36px rgba(0,0,0,.3); padding: 12px 14px; font-size: 12.5px; }
    .pbd h4 { margin: 0 0 2px; font-size: 13.5px; display: flex; align-items: center; gap: 8px; }
    .pbd h4 .x { margin-left: auto; border: 0; background: none; color: var(--muted); cursor: pointer; font-size: 15px; }
    .pbd .sub { color: var(--muted); font-size: 11.5px; margin-bottom: 8px; }
    .pbd .gap { background: var(--bg2, rgba(99,102,241,.08)); border-radius: 8px; padding: 8px 10px; margin: 6px 0 10px; line-height: 1.5; }
    .pbd .gap b { font-weight: 700; }
    .pbd .gap ul { margin: 4px 0 0; padding-left: 16px; }
    .pbd .tabs { display: flex; gap: 6px; margin-bottom: 6px; }
    .pbd .tabs button { font: inherit; font-size: 11.5px; padding: 3px 10px; border-radius: 99px; border: 1px solid var(--border); background: transparent; color: var(--text); cursor: pointer; }
    .pbd .tabs button.on { background: var(--indigo, #6366f1); border-color: var(--indigo, #6366f1); color: #fff; }
    .pbd table { width: 100%; border-collapse: collapse; }
    .pbd th { text-align: left; font-size: 10.5px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); font-weight: 600; padding: 4px 4px; border-bottom: 1px solid var(--border); }
    .pbd td { padding: 5px 4px; border-bottom: 1px solid var(--border); vertical-align: top; }
    .pbd td.n { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
    .pbd td a { color: var(--text); text-decoration: none; }
    .pbd td a:hover { text-decoration: underline; }
    .pbd .tag { display: inline-block; margin-left: 6px; font-size: 10.5px; padding: 0 6px; border-radius: 99px; border: 1px solid var(--border); color: var(--muted); white-space: nowrap; }
    .pbd .over { color: var(--red, #dc2626); }
    .pbd .under { color: var(--amber, #d97706); }
    .pbd tr.tot td { font-weight: 700; border-top: 2px solid var(--border); border-bottom: 0; }
    .pbd tr.sub td { color: var(--muted); font-style: italic; border-bottom: 0; }
    .pbd tr.card td { font-weight: 700; border-top: 1px dashed var(--border); border-bottom: 0; }
    .pbd .empty { color: var(--muted); font-style: italic; padding: 6px 0; }
    .pbd-link { cursor: pointer; text-decoration: underline dotted; text-underline-offset: 3px; }
    .pbd-link:hover { color: var(--indigo, #6366f1); }
  `;
  document.head.appendChild(css);

  let box = null;
  const close = () => { if (box) { box.remove(); box = null; } };
  document.addEventListener("click", (e) => { if (box && !box.contains(e.target) && !(e.target.closest && e.target.closest(".pbd-link"))) close(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });
  const el = (tag, cls, text) => { const x = document.createElement(tag); if (cls) x.className = cls; if (text != null) x.textContent = text; return x; };
  const num = (v) => Number(v) || 0;

  // data: { label, estMs, spentMs, tasks, cfg, other, fmt }
  //   tasks = rows due in these dates, cfg = configured tasks (their share for
  //   these dates), other = tracked here but not due in these dates.
  // Tracked minus estimate for one row: "+14m" in red when over, "-1h" in
  // amber when under (or nothing tracked yet), "0m" when it matches.
  function diffCell(ms, plain) {
    const fmt = curFmt;
    if (plain) return el("td", "n", "+" + fmt(Math.abs(ms)));
    if (Math.abs(ms) < 60000) return el("td", "n", "0m");
    return el("td", "n " + (ms > 0 ? "over" : "under"), (ms > 0 ? "+" : "\u2212") + fmt(Math.abs(ms)));
  }
  let curFmt = (ms) => Math.round(num(ms) / 60000) + "m";
  function build(data, kind) {
    const fmt = data.fmt || ((ms) => Math.round(num(ms) / 60000) + "m");
    curFmt = fmt;
    const due = (data.tasks || []).map((t) => ({ name: t.name, url: t.url, est: num(t.estimateMs), spent: num(t.spentMs), kind: "due" }));
    const cfg = (data.cfg || []).map((t) => ({ name: t.name, url: t.url, est: num(t.dayEstimateMs || t.estimateMs), spent: num(t.spentMs), kind: "cfg" }));
    const other = (data.other || []).map((t) => ({ name: t.name, url: t.url, est: 0, spent: num(t.spentMs), kind: "other" }));
    const listed = due.concat(cfg);
    const listedSpent = listed.reduce((a, r) => a + r.spent, 0);
    const otherSpent = Math.max(other.reduce((a, r) => a + r.spent, 0), num(data.spentMs) - listedSpent, 0);
    const over = listed.filter((r) => r.est > 0 && r.spent > r.est);
    const overMs = over.reduce((a, r) => a + (r.spent - r.est), 0);
    const noEst = listed.filter((r) => !r.est && r.spent > 0);
    const noEstMs = noEst.reduce((a, r) => a + r.spent, 0);
    const notStarted = listed.filter((r) => r.est > 0 && !r.spent);
    const notStartedMs = notStarted.reduce((a, r) => a + r.est, 0);
    const under = listed.filter((r) => r.est > 0 && r.spent > 0 && r.spent < r.est);
    const underMs = under.reduce((a, r) => a + (r.est - r.spent), 0);

    box.textContent = "";
    const h = el("h4", "", kind === "est" ? "Estimated " + fmt(data.estMs) : "Tracked " + fmt(data.spentMs));
    const x = el("button", "x", "✕"); x.type = "button"; x.title = "Close"; x.onclick = close;
    h.appendChild(x);
    box.append(h, el("div", "sub", (data.label ? data.label + " · " : "") + "click a task to open it in ClickUp"));

    // The gap between the two numbers, in plain words.
    const diff = num(data.spentMs) - num(data.estMs);
    const gap = el("div", "gap");
    const head = el("div");
    head.innerHTML = diff === 0 ? "<b>Tracked matches the estimate.</b>"
      : "<b>Tracked " + fmt(Math.abs(diff)) + (diff > 0 ? " more" : " less") + " than estimated</b> (" + fmt(data.estMs) + " estimated, " + fmt(data.spentMs) + " tracked).";
    gap.appendChild(head);
    const ul = el("ul");
    const li = (t) => ul.appendChild(el("li", "", t));
    if (otherSpent > 0) li(fmt(otherSpent) + " tracked on " + (other.length ? other.length + " task" + (other.length === 1 ? "" : "s") : "tasks") + " not due in these dates (not part of the estimate).");
    if (overMs > 0) li(fmt(overMs) + " over the estimate on " + over.length + " task" + (over.length === 1 ? "" : "s") + ".");
    if (noEstMs > 0) li(fmt(noEstMs) + " on " + noEst.length + " task" + (noEst.length === 1 ? "" : "s") + " with no estimate.");
    if (notStartedMs > 0) li(fmt(notStartedMs) + " estimated on " + notStarted.length + " task" + (notStarted.length === 1 ? "" : "s") + " with nothing tracked yet.");
    if (underMs > 0) li(fmt(underMs) + " of estimate still left on " + under.length + " task" + (under.length === 1 ? "" : "s") + " in progress.");
    if (ul.children.length) gap.appendChild(ul);
    box.appendChild(gap);

    const tabs = el("div", "tabs");
    for (const [k, t] of [["est", "Estimated tasks"], ["trk", "Tracked time"]]) {
      const b = el("button", k === kind ? "on" : "", t); b.type = "button";
      b.onclick = (e) => { e.stopPropagation(); build(data, k); };
      tabs.appendChild(b);
    }
    box.appendChild(tabs);

    const rows = kind === "est"
      ? listed.filter((r) => r.est > 0).sort((a, b) => b.est - a.est)
      : listed.concat(other).filter((r) => r.spent > 0).sort((a, b) => b.spent - a.spent);
    if (!rows.length) { box.appendChild(el("div", "empty", kind === "est" ? "No task has an estimate here." : "Nothing tracked here yet.")); return; }
    const tbl = el("table");
    const hr = el("tr");
    for (const c of ["Task", "Estimate", "Tracked", "Difference"]) hr.appendChild(el("th", c === "Task" ? "" : "n", c));
    tbl.appendChild(hr);
    for (const r of rows) {
      const tr = el("tr");
      const td = el("td");
      const a = el("a", "", r.name || "(task)");
      if (r.url) { a.href = r.url; a.target = "_blank"; a.rel = "noopener"; }
      td.appendChild(a);
      if (r.kind === "other") td.appendChild(el("span", "tag", "not due in these dates"));
      if (r.kind === "cfg") td.appendChild(el("span", "tag", "configured, share for these dates"));
      tr.append(td, el("td", "n", r.est ? fmt(r.est) : "-"));
      const sp = el("td", "n" + (r.est && r.spent > r.est ? " over" : ""), r.spent ? fmt(r.spent) : "-");
      tr.append(sp, diffCell(r.spent - r.est, r.kind === "other"));
      tbl.appendChild(tr);
    }
    // Totals, so the rows visibly add up to the card's numbers: these tasks, then
    // (when the card counts more) the time on other tasks, then the card total.
    const sumEst = rows.reduce((a, r) => a + r.est, 0), sumSpent = rows.reduce((a, r) => a + r.spent, 0);
    const foot = (cls, label, est, spent) => {
      const tr = el("tr", cls);
      tr.append(el("td", "", label), el("td", "n", est ? fmt(est) : "-"), el("td", "n", spent ? fmt(spent) : "-"), diffCell(spent - est, false));
      tbl.appendChild(tr);
    };
    foot("tot", "Total (" + rows.length + " task" + (rows.length === 1 ? "" : "s") + " above)", sumEst, sumSpent);
    const restEst = num(data.estMs) - sumEst, restSpent = num(data.spentMs) - sumSpent;
    // What the card counts beyond the rows above, each labelled for what it is.
    const signed = (ms) => (ms < 0 ? "−" : "+") + fmt(Math.abs(ms));
    const rest = (label, est, spent) => {
      const tr = el("tr", "sub");
      tr.append(el("td", "", label), el("td", "n", est ? signed(est) : "-"), el("td", "n", spent ? signed(spent) : "-"), el("td", "n", ""));
      tbl.appendChild(tr);
    };
    const big = (ms) => Math.abs(ms) >= 60000;
    if (big(restEst)) rest(restEst > 0 && kind === "trk" ? "Estimate on tasks with nothing tracked yet (see Estimated tasks)" : "Estimate the card counts that isn't in a task above", restEst, 0);
    if (big(restSpent)) rest(restSpent > 0
      ? (kind === "est" ? "Tracked on tasks with no estimate or not due in these dates (see Tracked time)" : "Tracked time the card counts that isn't in a task above (e.g. a running timer)")
      : "Tracked on these tasks outside the card's dates", 0, restSpent);
    if (big(restEst) || big(restSpent)) foot("card", "Card total", num(data.estMs), num(data.spentMs));
    box.appendChild(tbl);
  }

  function open(anchor, data, kind) {
    close();
    box = el("div", "pbd");
    box.onclick = (e) => e.stopPropagation();
    document.body.appendChild(box);
    build(data, kind === "trk" ? "trk" : "est");
    const r = anchor.getBoundingClientRect();
    const w = box.offsetWidth, hgt = box.offsetHeight;
    let top = r.bottom + 6;
    if (top + hgt > window.innerHeight - 8) top = Math.max(8, r.top - hgt - 6);
    box.style.top = Math.round(top) + "px";
    box.style.left = Math.round(Math.max(8, Math.min(window.innerWidth - w - 8, r.right - w))) + "px";
  }

  // Make a value clickable; getData() is read at click time (always current).
  function attach(valueEl, kind, getData) {
    if (!valueEl) return;
    valueEl.classList.add("pbd-link");
    valueEl.title = kind === "est" ? "Show the tasks behind this estimate" : "Show where this tracked time went";
    valueEl.onclick = (e) => { e.stopPropagation(); const d = getData(); if (d) open(valueEl, d, kind); };
  }
  // The This week card's breakdown: every task's share added up over the days
  // shown (Mon -> today, or Mon -> Friday). A task due after these days is
  // marked with its due date - it's here for the days it's being worked on.
  function fromWeek(w, agg, label, fmt) {
    const days = (w && Array.isArray(w.perDay) ? w.perDay : []).filter((d) => d && d.ts <= agg.toTs);
    const due = new Map(), cfg = new Map(), other = new Map();
    const add = (m, t, est, spent) => {
      const k = String(t.id || t.name);
      const r = m.get(k) || { name: t.name, url: t.url, estimateMs: 0, dayEstimateMs: 0, spentMs: 0, dueDateMs: Number(t.dueDateMs) || 0 };
      r.estimateMs += est; r.dayEstimateMs += est; r.spentMs += spent;
      m.set(k, r);
    };
    for (const d of days) {
      for (const t of d.tasks || []) add(t.type === "cfg" || t.type === "extra" ? cfg : due, t, num(t.estimateMs), num(t.spentMs));
      for (const t of d.trackedTasks || []) add(other, t, 0, num(t.spentMs));
    }
    const short = (ms) => new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
    const tasks = [...due.values()].map((r) => (r.dueDateMs > agg.toTs ? { ...r, name: r.name + " (due " + short(r.dueDateMs) + ")" } : r));
    return { label, estMs: num(agg.estimateMs), spentMs: num(agg.spentMs), tasks, cfg: [...cfg.values()], other: [...other.values()], fmt };
  }
  window.PcmBreakdown = { open, attach, close, fromWeek };
})();
