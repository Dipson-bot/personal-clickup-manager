// Calendar: a date chip (English + Nepali date, and what's coming up at the
// office) on the dashboard, popup and side panel. Clicking it opens a month
// view with both dates, company holidays and work-from-home days, and how many
// ClickUp tasks are due each day; clicking a day lists that day's tasks.
// Company days come from the shared settings file (every copy gets the same
// list); the background keeps them in storage as companyCalendar.
(() => {
  "use strict";
  // ---- Bikram Sambat (Nepali) dates ----
  // Days in each month of BS 2000-2090. Month lengths from the open-source
  // nepali-date-converter package (MIT, Subesh Bhandari), checked against known
  // dates (Nepali New Year 2080-2083, Vijaya Dashami 2082).
  const BS_START = 2000;
  const BS_MONTHS = [
    [30,32,31,32,31,30,30,30,29,30,29,31],
    [31,31,32,31,31,31,30,29,30,29,30,30],
    [31,31,32,32,31,30,30,29,30,29,30,30],
    [31,32,31,32,31,30,30,30,29,29,30,31],
    [30,32,31,32,31,30,30,30,29,30,29,31],
    [31,31,32,31,31,31,30,29,30,29,30,30],
    [31,31,32,32,31,30,30,29,30,29,30,30],
    [31,32,31,32,31,30,30,30,29,29,30,31],
    [31,31,31,32,31,31,29,30,30,29,29,31],
    [31,31,32,31,31,31,30,29,30,29,30,30],
    [31,31,32,32,31,30,30,29,30,29,30,30],
    [31,32,31,32,31,30,30,30,29,29,30,31],
    [31,31,31,32,31,31,29,30,30,29,30,30],
    [31,31,32,31,31,31,30,29,30,29,30,30],
    [31,31,32,32,31,30,30,29,30,29,30,30],
    [31,32,31,32,31,30,30,30,29,29,30,31],
    [31,31,31,32,31,31,29,30,30,29,30,30],
    [31,31,32,31,31,31,30,29,30,29,30,30],
    [31,32,31,32,31,30,30,29,30,29,30,30],
    [31,32,31,32,31,30,30,30,29,30,29,31],
    [31,31,31,32,31,31,30,29,30,29,30,30],
    [31,31,32,31,31,31,30,29,30,29,30,30],
    [31,32,31,32,31,30,30,30,29,29,30,30],
    [31,32,31,32,31,30,30,30,29,30,29,31],
    [31,31,31,32,31,31,30,29,30,29,30,30],
    [31,31,32,31,31,31,30,29,30,29,30,30],
    [31,32,31,32,31,30,30,30,29,29,30,31],
    [30,32,31,32,31,30,30,30,29,30,29,31],
    [31,31,32,31,31,31,30,29,30,29,30,30],
    [31,31,32,31,32,30,30,29,30,29,30,30],
    [31,32,31,32,31,30,30,30,29,29,30,31],
    [30,32,31,32,31,30,30,30,29,30,29,31],
    [31,31,32,31,31,31,30,29,30,29,30,30],
    [31,31,32,32,31,30,30,29,30,29,30,30],
    [31,32,31,32,31,30,30,30,29,29,30,31],
    [30,32,31,32,31,31,29,30,30,29,29,31],
    [31,31,32,31,31,31,30,29,30,29,30,30],
    [31,31,32,32,31,30,30,29,30,29,30,30],
    [31,32,31,32,31,30,30,30,29,29,30,31],
    [31,31,31,32,31,31,29,30,30,29,30,30],
    [31,31,32,31,31,31,30,29,30,29,30,30],
    [31,31,32,32,31,30,30,29,30,29,30,30],
    [31,32,31,32,31,30,30,30,29,29,30,31],
    [31,31,31,32,31,31,29,30,30,29,30,30],
    [31,31,32,31,31,31,30,29,30,29,30,30],
    [31,32,31,32,31,30,30,29,30,29,30,30],
    [31,32,31,32,31,30,30,30,29,29,30,31],
    [31,31,31,32,31,31,30,29,30,29,30,30],
    [31,31,32,31,31,31,30,29,30,29,30,30],
    [31,32,31,32,31,30,30,30,29,29,30,30],
    [31,32,31,32,31,30,30,30,29,30,29,31],
    [31,31,31,32,31,31,30,29,30,29,30,30],
    [31,31,32,31,31,31,30,29,30,29,30,30],
    [31,32,31,32,31,30,30,30,29,29,30,30],
    [31,32,31,32,31,30,30,30,29,30,29,31],
    [31,31,32,31,31,31,30,29,30,29,30,30],
    [31,31,32,31,32,30,30,29,30,29,30,30],
    [31,32,31,32,31,30,30,30,29,29,30,31],
    [30,32,31,32,31,30,30,30,29,30,29,31],
    [31,31,32,31,31,31,30,29,30,29,30,30],
    [31,31,32,32,31,30,30,29,30,29,30,30],
    [31,32,31,32,31,30,30,30,29,29,30,31],
    [30,32,31,32,31,31,29,30,29,30,29,31],
    [31,31,32,31,31,31,30,29,30,29,30,30],
    [31,31,32,32,31,30,30,29,30,29,30,30],
    [31,32,31,32,31,30,30,30,29,29,30,31],
    [31,31,31,32,31,31,29,30,30,29,29,31],
    [31,31,32,31,31,31,30,29,30,29,30,30],
    [31,31,32,32,31,30,30,29,30,29,30,30],
    [31,32,31,32,31,30,30,30,29,29,30,31],
    [31,31,31,32,31,31,29,30,30,29,30,30],
    [31,31,32,31,31,31,30,29,30,29,30,30],
    [31,32,31,32,31,30,30,29,30,29,30,30],
    [31,32,31,32,31,30,30,30,29,29,30,31],
    [31,31,31,32,31,31,30,29,30,29,30,30],
    [31,31,32,31,31,31,30,29,30,29,30,30],
    [31,32,31,32,31,30,30,30,29,29,30,30],
    [31,32,31,32,31,30,30,30,29,30,29,31],
    [31,31,31,32,31,31,30,29,30,29,30,30],
    [31,31,32,31,31,31,30,29,30,29,30,30],
    [31,32,31,32,31,30,30,30,29,29,30,30],
    [31,32,31,32,31,30,30,30,29,30,29,31],
    [31,31,32,31,31,31,30,29,30,29,30,30],
    [31,31,32,31,31,31,30,29,30,29,30,30],
    [31,32,31,32,31,30,30,30,29,29,30,31],
    [30,32,31,32,31,30,30,30,29,30,29,31],
    [31,31,32,31,31,31,30,29,30,29,30,30],
    [31,31,32,31,31,31,30,30,29,30,30,30],
    [30,31,32,32,30,31,30,30,29,30,30,30],
    [30,32,31,32,31,30,30,30,29,30,30,30],
    [30,32,31,32,31,30,30,30,29,30,30,30],
  ];
  const BS_EPOCH = Date.UTC(1943, 3, 14); // 1 Baisakh 2000
  const BS_NAMES = ["Baisakh", "Jestha", "Asar", "Shrawan", "Bhadra", "Ashwin", "Kartik", "Mangsir", "Poush", "Magh", "Falgun", "Chaitra"];
  // A local date -> { y, m (1-12), d } in BS, or null outside the table.
  function toBS(date) {
    const t = new Date(date);
    let days = Math.round((Date.UTC(t.getFullYear(), t.getMonth(), t.getDate()) - BS_EPOCH) / 86400000);
    if (days < 0) return null;
    for (let i = 0; i < BS_MONTHS.length; i++) {
      for (let m = 0; m < 12; m++) {
        const len = BS_MONTHS[i][m];
        if (days < len) return { y: BS_START + i, m: m + 1, d: days + 1 };
        days -= len;
      }
    }
    return null;
  }
  const bsLabel = (date) => { const b = toBS(date); return b ? BS_NAMES[b.m - 1] + " " + b.d + ", " + b.y : ""; };

  // ---- company days (holidays, work from home) ----
  let company = [];
  const ymd = (ts) => { const d = new Date(ts); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); };
  const parseYmd = (s) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || "")); return m ? new Date(+m[1], +m[2] - 1, +m[3]).getTime() : 0; };
  function eventsOn(ts) {
    const k = ymd(ts);
    return company.filter((e) => e && e.from && k >= e.from && k <= (e.to || e.from));
  }
  const isHoliday = (ts) => eventsOn(ts).some((e) => e.kind === "holiday");
  const isWfh = (ts) => eventsOn(ts).some((e) => e.kind === "wfh");
  const fmtShort = (ts) => new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const icon = (kind) => kind === "holiday" ? "\uD83C\uDF89" : kind === "wfh" ? "\uD83C\uDFE0" : "\uD83D\uDCCC";
  // Today's status or the next thing starting within two weeks, for the chip.
  function headsUp(now) {
    const today = eventsOn(now);
    const hol = today.find((e) => e.kind === "holiday");
    if (hol) return icon("holiday") + " " + hol.title;
    const wfh = today.find((e) => e.kind === "wfh");
    const soon = company.filter((e) => e.from > ymd(now) && parseYmd(e.from) - now < 14 * 86400000).sort((a, b) => a.from.localeCompare(b.from))[0];
    if (soon && (!wfh || soon.kind === "holiday")) return (wfh ? icon("wfh") + " WFH \u00b7 " : "") + icon(soon.kind) + " " + soon.title + " from " + fmtShort(parseYmd(soon.from));
    if (wfh) return icon("wfh") + " Work from home" + (wfh.to ? " until " + fmtShort(parseYmd(wfh.to)) : "");
    return "";
  }

  // ---- tasks due per day (from what the extension already loaded) ----
  let state = null;
  function dueCounts() {
    const seen = new Set(), out = new Map();
    const add = (list) => { for (const t of Array.isArray(list) ? list : []) { if (!t || !t.dueDateMs || seen.has(String(t.id))) continue; seen.add(String(t.id)); const k = ymd(t.dueDateMs); const c = out.get(k) || { n: 0, open: 0 }; c.n++; if (!t.done) c.open++; out.set(k, c); } };
    const st = state || {};
    for (const b of [st, st.todayFilter, st.tomorrow, st.thisWeek, st.nextWeek, st.custom]) if (b) add(b.tasks);
    return out;
  }

  const css = document.createElement("style");
  css.textContent = `
    .pcal-chip { display: inline-flex; align-items: center; gap: 6px; font: inherit; font-size: 12px; font-weight: 600; padding: 4px 10px; border-radius: 99px; border: 1px solid var(--border); background: var(--card); color: var(--text); cursor: pointer; white-space: nowrap; max-width: 100%; overflow: hidden; text-overflow: ellipsis; }
    .pcal-chip:hover { border-color: var(--indigo, #6366f1); }
    .pcal-chip .bs { color: var(--muted); font-weight: 500; }
    .pcal-chip .ev { color: var(--indigo, #6366f1); font-weight: 600; }
    .pcal-line { margin: 0 0 8px; }
    .pcal-pop { position: fixed; z-index: 3000; width: min(380px, calc(100vw - 16px)); background: var(--card); color: var(--text); border: 1px solid var(--border); border-radius: 12px; box-shadow: 0 16px 36px rgba(0,0,0,.3); padding: 12px; font-size: 12.5px; }
    .pcal-head { display: flex; align-items: center; gap: 6px; margin-bottom: 8px; }
    .pcal-head .t { flex: 1; text-align: center; }
    .pcal-head .t b { display: block; font-size: 13.5px; }
    .pcal-head .t span { color: var(--muted); font-size: 11.5px; }
    .pcal-head button { border: 1px solid var(--border); background: var(--bg2, transparent); color: var(--text); border-radius: 7px; width: 28px; height: 26px; cursor: pointer; font: inherit; }
    .pcal-grid { display: grid; grid-template-columns: repeat(7, 1fr); gap: 3px; }
    .pcal-wd { text-align: center; font-size: 10.5px; color: var(--muted); font-weight: 600; text-transform: uppercase; padding: 2px 0; }
    .pcal-day { position: relative; min-height: 42px; border-radius: 7px; border: 1px solid transparent; padding: 3px 4px; cursor: pointer; background: var(--bg2, rgba(127,127,127,.06)); text-align: left; font: inherit; color: var(--text); }
    .pcal-day:hover { border-color: var(--indigo, #6366f1); }
    .pcal-day.out { opacity: .38; }
    .pcal-day.we { color: var(--muted); }
    .pcal-day.today { border-color: var(--indigo, #6366f1); box-shadow: inset 0 0 0 1px var(--indigo, #6366f1); }
    .pcal-day.hol { background: rgba(220,38,38,.14); }
    .pcal-day.wfh { background: rgba(59,130,246,.13); }
    .pcal-day .ad { font-weight: 700; font-size: 12.5px; line-height: 1.1; }
    .pcal-day .bsd { display: block; font-size: 10px; color: var(--muted); }
    .pcal-day .n { position: absolute; right: 3px; top: 3px; font-size: 9.5px; font-weight: 700; padding: 0 4px; border-radius: 99px; background: var(--indigo, #6366f1); color: #fff; }
    .pcal-day .n.late { background: var(--amber, #d97706); }
    .pcal-legend { display: flex; flex-wrap: wrap; gap: 10px; margin: 8px 0 4px; font-size: 11px; color: var(--muted); }
    .pcal-legend i { display: inline-block; width: 10px; height: 10px; border-radius: 3px; margin-right: 4px; vertical-align: -1px; }
    .pcal-ev { margin-top: 8px; border-top: 1px solid var(--border); padding-top: 8px; display: grid; gap: 4px; }
    .pcal-ev div { display: flex; gap: 6px; }
    .pcal-ev small { color: var(--muted); margin-left: auto; white-space: nowrap; }
    .pcal-hint { color: var(--muted); font-size: 11px; margin-top: 6px; }
  `;
  document.head.appendChild(css);

  let pop = null, view = null;
  const el = (tag, cls, text) => { const x = document.createElement(tag); if (cls) x.className = cls; if (text != null) x.textContent = text; return x; };
  const close = () => { if (pop) { pop.remove(); pop = null; } };
  document.addEventListener("click", (e) => { if (pop && !pop.contains(e.target) && !(e.target.closest && e.target.closest(".pcal-chip"))) close(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });

  function paintMonth() {
    pop.textContent = "";
    const y = view.getFullYear(), m = view.getMonth();
    const first = new Date(y, m, 1), last = new Date(y, m + 1, 0);
    const head = el("div", "pcal-head");
    const prev = el("button", "", "\u2039"); prev.type = "button"; prev.title = "Previous month";
    const next = el("button", "", "\u203A"); next.type = "button"; next.title = "Next month";
    prev.onclick = (e) => { e.stopPropagation(); view = new Date(y, m - 1, 1); paintMonth(); };
    next.onclick = (e) => { e.stopPropagation(); view = new Date(y, m + 1, 1); paintMonth(); };
    const t = el("div", "t");
    t.appendChild(el("b", "", first.toLocaleDateString(undefined, { month: "long", year: "numeric" })));
    const bA = toBS(first), bB = toBS(last);
    if (bA && bB) t.appendChild(el("span", "", BS_NAMES[bA.m - 1] + (bA.m !== bB.m || bA.y !== bB.y ? " \u2013 " + BS_NAMES[bB.m - 1] : "") + " " + bB.y));
    head.append(prev, t, next);
    pop.appendChild(head);
    const grid = el("div", "pcal-grid");
    for (const w of ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]) grid.appendChild(el("div", "pcal-wd", w));
    const counts = dueCounts();
    const todayK = ymd(Date.now());
    const start = new Date(y, m, 1 - first.getDay());
    for (let i = 0; i < 42; i++) {
      const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
      if (i >= 35 && d.getMonth() !== m) break;
      const k = ymd(d), ts = d.getTime();
      const b = el("button", "pcal-day"); b.type = "button";
      if (d.getMonth() !== m) b.classList.add("out");
      if (d.getDay() === 0 || d.getDay() === 6) b.classList.add("we");
      if (k === todayK) b.classList.add("today");
      const evs = eventsOn(ts);
      if (evs.some((e) => e.kind === "holiday")) b.classList.add("hol"); else if (evs.some((e) => e.kind === "wfh")) b.classList.add("wfh");
      b.appendChild(el("span", "ad", String(d.getDate())));
      const bs = toBS(d);
      if (bs) b.appendChild(el("span", "bsd", bs.d === 1 ? BS_NAMES[bs.m - 1].slice(0, 3) + " 1" : String(bs.d)));
      const c = counts.get(k);
      if (c && c.n) { const n = el("span", "n" + (c.open && k < todayK ? " late" : ""), String(c.n)); n.title = c.n + " task" + (c.n === 1 ? "" : "s") + " due" + (c.open ? " (" + c.open + " not done)" : ""); b.appendChild(n); }
      b.title = d.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" }) + (bs ? " \u00b7 " + BS_NAMES[bs.m - 1] + " " + bs.d + ", " + bs.y : "") +
        (evs.length ? "\n" + evs.map((e) => icon(e.kind) + " " + e.title).join("\n") : "") + (c && c.n ? "\n" + c.n + " task" + (c.n === 1 ? "" : "s") + " due" : "") + "\nClick to list this day's tasks";
      b.onclick = (e) => { e.stopPropagation(); close(); if (typeof window.pcmPickDay === "function") window.pcmPickDay(ts); };
      grid.appendChild(b);
    }
    pop.appendChild(grid);
    const lg = el("div", "pcal-legend");
    lg.innerHTML = '<span><i style="background:rgba(220,38,38,.35)"></i>Holiday</span><span><i style="background:rgba(59,130,246,.35)"></i>Work from home</span><span><i style="background:var(--indigo,#6366f1)"></i>Tasks due</span>';
    pop.appendChild(lg);
    // Company days in this month and the next few weeks.
    const fromK = ymd(new Date(y, m, 1)), toK = ymd(new Date(y, m + 2, 0));
    const list = company.filter((e) => (e.to || e.from) >= fromK && e.from <= toK).sort((a, b) => a.from.localeCompare(b.from));
    if (list.length) {
      const ev = el("div", "pcal-ev");
      for (const e of list) {
        const row = el("div");
        row.append(icon(e.kind) + " " + e.title);
        row.appendChild(el("small", "", fmtShort(parseYmd(e.from)) + (e.to && e.to !== e.from ? " \u2013 " + fmtShort(parseYmd(e.to)) : "")));
        ev.appendChild(row);
      }
      pop.appendChild(ev);
    }
    pop.appendChild(el("div", "pcal-hint", "Task counts come from the weeks the extension has loaded (this week, next week and your filter)."));
  }
  function open(anchor) {
    close();
    pop = el("div", "pcal-pop");
    pop.onclick = (e) => e.stopPropagation();
    document.body.appendChild(pop);
    view = new Date(); view.setDate(1);
    paintMonth();
    const r = anchor.getBoundingClientRect();
    const w = pop.offsetWidth, h = pop.offsetHeight;
    let top = r.bottom + 6;
    if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 6);
    pop.style.top = Math.round(top) + "px";
    pop.style.left = Math.round(Math.max(8, Math.min(window.innerWidth - w - 8, r.left))) + "px";
  }

  // ---- the chip ----
  function paintChip() {
    let host = document.getElementById("pcmCalChip");
    if (!host) {
      // Popup / side panel: a slim line under the header.
      const header = document.querySelector(".header");
      if (!header || document.querySelector('.panel[data-panel="dashboard"]')) return;
      host = el("div", "pcal-line"); host.id = "pcmCalChip";
      header.after(host);
    }
    const now = Date.now();
    let chip = host.querySelector(".pcal-chip");
    if (!chip) { chip = el("button", "pcal-chip"); chip.type = "button"; chip.onclick = (e) => { e.stopPropagation(); if (pop) close(); else open(chip); }; host.appendChild(chip); }
    chip.textContent = "";
    chip.append("\uD83D\uDCC5 " + new Date(now).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" }));
    const bs = bsLabel(now);
    if (bs) chip.appendChild(el("span", "bs", "\u00b7 " + bs));
    const hu = headsUp(now);
    if (hu) chip.appendChild(el("span", "ev", "\u00b7 " + hu));
    chip.title = "Calendar: English and Nepali dates, company holidays, work-from-home days and tasks due. Click to open.";
  }
  async function load() {
    try {
      const g = await chrome.storage.local.get(["companyCalendar", "clickupState"]);
      company = Array.isArray(g.companyCalendar) ? g.companyCalendar : [];
      state = g.clickupState || null;
    } catch (e) {}
    paintChip();
    if (pop) paintMonth();
  }
  try { chrome.storage.onChanged.addListener((ch, area) => { if (area === "local" && (ch.companyCalendar || ch.clickupState)) load(); }); } catch (e) {}
  setInterval(paintChip, 60000); // the date rolls over at midnight
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", load); else load();
  window.PcmCalendar = { toBS, bsLabel, isHoliday, isWfh, eventsOn, open, refresh: load };
})();
