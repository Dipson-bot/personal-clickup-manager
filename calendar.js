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
  // BS { y, m (1-12), d } -> that local date (midnight), or 0 outside the table.
  function fromBS(y, m, d) {
    const i = y - BS_START;
    if (i < 0 || i >= BS_MONTHS.length || m < 1 || m > 12) return 0;
    let days = d - 1;
    for (let a = 0; a < i; a++) for (const len of BS_MONTHS[a]) days += len;
    for (let b = 0; b < m - 1; b++) days += BS_MONTHS[i][b];
    const u = new Date(BS_EPOCH + days * 86400000);
    return new Date(u.getUTCFullYear(), u.getUTCMonth(), u.getUTCDate()).getTime();
  }
  const bsMonthLen = (y, m) => (BS_MONTHS[y - BS_START] || [])[m - 1] || 30;

  // ---- named days (festivals) ----
  // What a day is, for everyone, whether or not the office closes (holidays come
  // from the team calendar). Built in for 2083 (checked against the Nepali
  // calendar); the team calendar file can add more years or correct a day with
  // entries of kind "festival" ({ from, title, short, group, main }), which win.
  // [full name, short label, group, main day (named in its box)]
  const FESTIVALS_BUILTIN = {
    "2026-08-28": ["Janai Purnima / Raksha Bandhan", "Janai Purnima", "", true],
    "2026-10-11": ["Ghatasthapana (Dashain begins)", "Ghatasthapana", "Dashain", false],
    "2026-10-17": ["Fulpati", "Fulpati", "Dashain", false],
    "2026-10-18": ["Maha Ashtami", "Ashtami", "Dashain", false],
    "2026-10-20": ["Maha Navami", "Navami", "Dashain", false],
    "2026-10-21": ["Vijaya Dashami - Dashain Tika", "Tika", "Dashain", true],
    "2026-10-22": ["Papankusha Ekadashi", "Ekadashi", "Dashain", false],
    "2026-10-25": ["Kojagrat Purnima (Dashain ends)", "Purnima", "Dashain", false],
    "2026-11-07": ["Kag Tihar (Tihar begins)", "Kag Tihar", "Tihar", false],
    "2026-11-08": ["Kukur Tihar · Gai Tihar · Laxmi Puja", "Laxmi Puja", "Tihar", true],
    "2026-11-10": ["Govardhan Puja · Mha Puja (Nepal Sambat new year)", "Govardhan", "Tihar", false],
    "2026-11-11": ["Bhai Tika (Tihar ends)", "Bhai Tika", "Tihar", true],
  };
  function festivals() {
    const out = { ...FESTIVALS_BUILTIN };
    for (const e of company) {
      if (!e || e.kind !== "festival" || !e.from) continue;
      out[e.from] = [e.title || "Festival", e.short || e.title || "Festival", e.group || "", !!e.main];
    }
    return out;
  }
  const festivalOn = (ts) => festivals()[ymd(ts)] || null;
  // English or Nepali months (the switch in the calendar's head), every page.
  let calMode = "ad";
  try { chrome.storage.local.get("calMode").then((g) => { if (g && (g.calMode === "bs" || g.calMode === "ad")) calMode = g.calMode; }).catch(() => {}); } catch (e) {}

  // ---- company days (holidays, work from home) ----
  let company = [];
  const ymd = (ts) => { const d = new Date(ts); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); };
  const parseYmd = (s) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || "")); return m ? new Date(+m[1], +m[2] - 1, +m[3]).getTime() : 0; };
  function eventsOn(ts) {
    const k = ymd(ts);
    return company.filter((e) => e && e.kind !== "festival" && e.from && k >= e.from && k <= (e.to || e.from));
  }
  const isHoliday = (ts) => eventsOn(ts).some((e) => e.kind === "holiday");
  const isWfh = (ts) => eventsOn(ts).some((e) => e.kind === "wfh");
  const fmtShort = (ts) => new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  // ---- times, for the date+time fields (reminders, a notice's "until") ----
  // These fields used to be impossible with a mouse: the calendar takes over
  // every click on them (it has to, or the browser opens its own picker on top),
  // so the hh:mm part never got a cursor and only the keyboard could reach it.
  // The calendar now sets the time itself, with these as the plumbing.
  const hhmmOf = (s) => {
    const m = /(\d{1,2}):(\d{2})/.exec(String(s || ""));
    if (!m) return "";
    const h = Math.min(23, Math.max(0, +m[1])), mi = Math.min(59, Math.max(0, +m[2]));
    return String(h).padStart(2, "0") + ":" + String(mi).padStart(2, "0");
  };
  const to12 = (hhmm) => {
    const m = /(\d{1,2}):(\d{2})/.exec(String(hhmm || "")) || [0, "9", "00"];
    const h = Math.min(23, Math.max(0, +m[1]));
    return { h12: h % 12 === 0 ? 12 : h % 12, min: Math.min(59, Math.max(0, +m[2])), pm: h >= 12 };
  };
  const from12 = (h12, min, pm) => {
    const h = (Math.min(12, Math.max(1, Number(h12) || 12)) % 12) + (pm ? 12 : 0);
    return String(h).padStart(2, "0") + ":" + String(Math.min(59, Math.max(0, Number(min) || 0))).padStart(2, "0");
  };
  const fmtTime12 = (hhmm) => { const t = to12(hhmm); return t.h12 + ":" + String(t.min).padStart(2, "0") + " " + (t.pm ? "PM" : "AM"); };
  const icon = (kind) => kind === "holiday" ? "\uD83C\uDF89" : kind === "wfh" ? "\uD83C\uDFE0" : kind === "fest" ? "\uD83E\uDE94" : "\uD83D\uDCCC";
  // An event's time ("2:00 PM") after its title.
  const evTime = (e) => { if (!e || !e.time) return ""; const [h, m] = e.time.split(":").map(Number); return " \u00b7 " + new Date(2000, 0, 1, h, m).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }); };
  // Today's status or the next thing starting within two weeks, for the chip.
  function headsUp(now) {
    const today = eventsOn(now);
    const hol = today.find((e) => e.kind === "holiday");
    if (hol) return icon("holiday") + " " + hol.title;
    const wfh = today.find((e) => e.kind === "wfh");
    const soon = company.filter((e) => e.from > ymd(now) && parseYmd(e.from) - now < 14 * 86400000).sort((a, b) => a.from.localeCompare(b.from))[0];
    if (soon && (!wfh || soon.kind === "holiday")) return (wfh ? icon("wfh") + " WFH \u00b7 " : "") + icon(soon.kind) + " " + soon.title + (soon.kind === "event" ? " " + fmtShort(parseYmd(soon.from)) + evTime(soon) : " from " + fmtShort(parseYmd(soon.from)));
    if (wfh) return icon("wfh") + " Work from home" + (wfh.to ? " until " + fmtShort(parseYmd(wfh.to)) : "");
    return "";
  }

  // ---- your reminders on each day ----
  // One-time ones on their date; repeating ones (daily / weekdays / weekly) on
  // every day they fire. Paused ones aren't shown, and the office reminders
  // follow the same rule as the background: no check-in / check-out on company
  // holidays, no cup reminder on holidays or work-from-home days.
  let reminders = [];
  const REM_SKIP = { "default-checkin": ["holiday"], "default-checkout": ["holiday"], "default-cups-noon": ["holiday", "wfh"] };
  function remindersOn(ts) {
    const day = new Date(ts); day.setHours(0, 0, 0, 0);
    const k = ymd(day.getTime()), dow = day.getDay();
    const out = [];
    for (const r of reminders) {
      if (!r || r.done || r.active === false || r.paused || !(Number(r.at) > 0)) continue;
      const at = new Date(Number(r.at));
      const first = new Date(at); first.setHours(0, 0, 0, 0);
      const rep = r.repeat || "none";
      let hit;
      if (rep === "none") hit = ymd(at.getTime()) === k;
      else if (day < first) hit = false; // not started yet
      else if (rep === "daily") hit = true;
      else if (rep === "weekdays") hit = dow !== 0 && dow !== 6;
      else if (rep === "weekly") hit = dow === at.getDay();
      if (!hit) continue;
      if ((REM_SKIP[r.id] || []).some((x) => (x === "holiday" ? isHoliday : isWfh)(day.getTime()))) continue;
      out.push({ time: at.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }), mins: at.getHours() * 60 + at.getMinutes(), text: String(r.text || "Reminder") });
    }
    return out.sort((a, b) => a.mins - b.mins);
  }

  // ---- tasks due per day (from what the extension already loaded) ----
  let state = null;
  function dueCounts() {
    const seen = new Set(), out = new Map();
    const add = (list) => { for (const t of Array.isArray(list) ? list : []) { if (!t || !t.dueDateMs || seen.has(String(t.id))) continue; seen.add(String(t.id)); const k = ymd(t.dueDateMs); const c = out.get(k) || { n: 0, open: 0 }; c.n++; if (!t.done) c.open++; out.set(k, c); } };
    const st = state || {};
    for (const b of [st, st.todayFilter, st.tomorrow, st.thisWeek, st.nextWeek, st.custom]) if (b) add(b.tasks);
    add(openAll && openAll.tasks); // all my open tasks, any date - later weeks and months too
    return out;
  }
  // All my open tasks with their due dates (the list Insights uses, kept in
  // insOpenCache): read when the calendar opens, asked for again when it is
  // more than 2 hours old - ClickUp is read at most once per open (3-min cache).
  let openAll = null, openAsked = 0;
  async function freshOpen() {
    if (openAll && Date.now() - (Number(openAll.at) || 0) < 2 * 3600000) return;
    if (Date.now() - openAsked < 10 * 60000) return;
    openAsked = Date.now();
    try {
      const r = await chrome.runtime.sendMessage({ type: "CLICKUP_OPEN_TASKS" });
      if (r && r.ok && r.data && Array.isArray(r.data.tasks)) {
        openAll = { at: Date.now(), tasks: r.data.tasks };
        try { const blob = { at: openAll.at, tasks: r.data.tasks }; if (JSON.stringify(blob).length < 3000000) await chrome.storage.local.set({ insOpenCache: blob }); } catch (e) {}
        if (pop) paintMonth();
      }
    } catch (e) {}
  }

  const css = document.createElement("style");
  css.textContent = `
    .pcal-chip { display: inline-flex; align-items: center; gap: 6px; font: inherit; font-size: 12px; font-weight: 600; padding: 4px 10px; border-radius: 99px; border: 1px solid var(--border); background: var(--card); color: var(--text); cursor: pointer; white-space: nowrap; max-width: 100%; overflow: hidden; text-overflow: ellipsis; }
    .pcal-chip:hover { border-color: var(--indigo, #6366f1); }
    .pcal-chip .bs { color: var(--muted); font-weight: 500; }
    .pcal-chip .ev { color: var(--indigo, #6366f1); font-weight: 600; }
    .pcal-line { margin: 0 0 8px; }
    /* box-sizing matters: without it the padding and border below are ADDED to
       the width, so "at most the viewport less 16px" came out 26px wider than
       asked and hung off the right edge of the 360px popup. Tall months (plus
       the time row) can still outgrow a short popup, so it scrolls rather than
       running off the bottom - with the time row pinned, see .pcal-timew. */
    .pcal-pop { position: fixed; z-index: 2147483000; box-sizing: border-box; width: min(380px, calc(100vw - 16px)); max-height: calc(100vh - 16px); overflow-y: auto; overscroll-behavior: contain; background: var(--card); color: var(--text); border: 1px solid var(--border); border-radius: 12px; box-shadow: 0 16px 36px rgba(0,0,0,.3); padding: 12px; font-size: 12.5px; }
    .pcal-head { display: flex; align-items: center; gap: 6px; margin-bottom: 8px; }
    .pcal-head .t { flex: 1; text-align: center; }
    .pcal-head .t b { display: block; font-size: 13.5px; }
    .pcal-head .t span { color: var(--muted); font-size: 11.5px; }
    .pcal-mode { display: inline-flex; margin-top: 4px; border: 1px solid var(--border); border-radius: 999px; overflow: hidden; }
    .pcal-head .pcal-mode button { width: auto; height: 20px; padding: 0 9px; border: 0; border-radius: 0; background: transparent; font-size: 10.5px; font-weight: 700; line-height: 20px; color: var(--muted); }
    .pcal-head .pcal-mode button.on { background: var(--indigo, #6366f1); color: #fff; }
    .pcal-day .fn { display: block; margin-top: 1px; font-size: 8.5px; line-height: 10px; font-weight: 700; color: #b45309; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    html[data-theme="dark"] .pcal-day .fn { color: #fbbf24; }
    .pcal-day.fest { box-shadow: inset 0 -2px 0 rgba(217,119,6,.55); }
    .pcal-head button { flex: none; display: inline-flex; align-items: center; justify-content: center; width: 30px; height: 30px; padding: 0; border: 1px solid var(--border); background: var(--bg2, transparent); color: var(--text); border-radius: 8px; cursor: pointer; line-height: 0; }
    .pcal-head button:hover { border-color: var(--indigo, #6366f1); color: var(--indigo, #6366f1); }
    .pcal-head button svg { width: 16px; height: 16px; display: block; }
    .pcal-grid { display: grid; grid-template-columns: repeat(7, 1fr); gap: 3px; }
    .pcal-wd { text-align: center; font-size: 10.5px; color: var(--muted); font-weight: 600; text-transform: uppercase; padding: 2px 0; }
    .pcal-day { position: relative; min-height: 42px; border-radius: 7px; border: 1px solid transparent; padding: 3px 4px; cursor: pointer; background: var(--bg2, rgba(127,127,127,.06)); text-align: left; font: inherit; color: var(--text); }
    .pcal-day:hover { border-color: var(--indigo, #6366f1); }
    /* Several days at once (a reminder on picked days): a tick box in the corner
       of every day; ticked days are outlined and their box filled. */
    .pcal-day .tk { position: absolute; right: 3px; bottom: 3px; width: 13px; height: 13px; box-sizing: border-box; border-radius: 3px; border: 1.5px solid var(--muted, #888); background: var(--card, #fff); display: flex; align-items: center; justify-content: center; font-size: 10px; line-height: 1; color: #fff; }
    /* With tick boxes the day is a little taller and the reminder clock sits
       ABOVE the box, so the two never overlap. */
    .pcal-day.mt { min-height: 54px; }
    .pcal-day.mt .rm { bottom: 18px; }
    .pcal-day.pick { border-color: var(--indigo, #6366f1); box-shadow: inset 0 0 0 2px var(--indigo, #6366f1); }
    .pcal-drag { user-select: none; touch-action: none; }
    .pcal-day.rng { border-color: var(--indigo, #6366f1) !important; box-shadow: inset 0 0 0 2px var(--indigo, #6366f1); background: rgba(99,102,241,.22) !important; }
    .pcal-rangebar { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 8px; margin: 8px 0 2px; font-size: 11.5px; color: var(--muted); }
    .pcal-rangebar button { width: auto; height: auto; font: inherit; font-size: 11.5px; font-weight: 600; padding: 3px 10px; border-radius: 999px; border: 1px solid var(--indigo, #6366f1); background: transparent; color: var(--indigo, #6366f1); cursor: pointer; }
    .pcal-rangebar button:hover:not(:disabled) { background: var(--indigo, #6366f1); color: #fff; }
    .pcal-rangebar button.on, .pcal-rangebar button.pri { background: var(--indigo, #6366f1); color: #fff; }
    .pcal-rangebar button:disabled { opacity: .45; cursor: not-allowed; }
    .pcal-rangebar.on { padding: 6px 8px; border-radius: 9px; background: rgba(99,102,241,.1); color: var(--text); }
    .pcal-for { margin: 0 0 6px; padding: 4px 8px; border-radius: 7px; background: rgba(99,102,241,.1); color: var(--indigo, #6366f1); font-size: 11.5px; font-weight: 700; text-align: center; }
    .pcal-head .pcal-jumpt { cursor: pointer; border-radius: 6px; padding: 0 4px; }
    .pcal-head .pcal-jumpt::after { content: " \u25BE"; font-size: 10px; opacity: .6; }
    .pcal-head .pcal-jumpt:hover { background: rgba(99,102,241,.12); color: var(--indigo, #6366f1); }
    .pcal-jump { margin: 0 0 8px; padding: 8px; border-radius: 10px; border: 1px solid var(--border); background: var(--bg2, rgba(127,127,127,.06)); }
    .pcal-jy { display: flex; align-items: center; justify-content: center; gap: 12px; margin-bottom: 6px; }
    .pcal-jy button { width: 30px; height: 28px; padding: 0; display: inline-flex; align-items: center; justify-content: center; border-radius: 8px; border: 1px solid var(--border); background: var(--card); color: var(--text); cursor: pointer; }
    .pcal-jy button svg { width: 15px; height: 15px; display: block; }
    .pcal-jy button:hover { border-color: var(--indigo, #6366f1); color: var(--indigo, #6366f1); }
    .pcal-jy b { min-width: 84px; text-align: center; font-size: 13.5px; }
    .pcal-day.rng-off { box-shadow: inset 0 0 0 2px var(--red, #dc2626) !important; background: rgba(220,38,38,.14) !important; text-decoration: line-through; }
    .pcal-go input.bad { border-color: var(--red, #dc2626) !important; }
    .pcal-jm { display: grid; grid-template-columns: repeat(4, 1fr); gap: 4px; }
    .pcal-jm button { padding: 5px 0; border-radius: 6px; border: 1px solid var(--border); background: var(--card); color: var(--text); cursor: pointer; font: inherit; font-size: 11.5px; }
    .pcal-jm button:hover:not(:disabled), .pcal-jm button.on { background: var(--indigo, #6366f1); border-color: var(--indigo, #6366f1); color: #fff; }
    .pcal-jm button:disabled { opacity: .35; cursor: not-allowed; }
    .pcal-day.pick .tk { background: var(--indigo, #6366f1); border-color: var(--indigo, #6366f1); }
    .pcal-multi { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin: 6px 0 0; font-size: 11.5px; color: var(--muted); }
    .pcal-multi b { color: var(--indigo, #6366f1); }
    .pcal-multi button { font: inherit; font-size: 11px; padding: 2px 8px; border-radius: 999px; border: 1px solid var(--border); background: transparent; color: var(--muted); cursor: pointer; }
    .pcal-day.out { opacity: .38; }
    .pcal-day.we { background: rgba(220,38,38,.14); }
    .pcal-day.today { border-color: var(--indigo, #6366f1); box-shadow: inset 0 0 0 1px var(--indigo, #6366f1); }
    .pcal-day.hol { background: rgba(239,68,68,.36); }
    .pcal-day.hol .ad { color: #ef4444; }
    .pcal-day.flash { animation: pcal-flash 1.6s ease 2; }
    @keyframes pcal-flash { 0%, 100% { box-shadow: 0 0 0 0 rgba(99,102,241,0); } 40% { box-shadow: 0 0 0 3px var(--indigo, #6366f1); } }
    .pcal-day.wfh { background: rgba(59,130,246,.16); }
    /* Dark mode: tints over a near-black background went muddy (maroon / grey),
       so dark gets its own brighter set - rose weekends, vivid rose holidays,
       sky-blue work-from-home, coloured day numbers and a soft glow on today. */
    html[data-theme="dark"] .pcal-day { background: rgba(255,255,255,.045); border-color: rgba(255,255,255,.05); }
    html[data-theme="dark"] .pcal-day:hover { background: rgba(255,255,255,.09); border-color: var(--indigo, #6366f1); }
    html[data-theme="dark"] .pcal-day.we { background: linear-gradient(160deg, rgba(251,113,133,.26), rgba(251,113,133,.12)); border-color: rgba(251,113,133,.22); }
    html[data-theme="dark"] .pcal-day.we .ad { color: #fda4af; }
    html[data-theme="dark"] .pcal-day.wfh { background: linear-gradient(160deg, rgba(56,189,248,.32), rgba(56,189,248,.14)); border-color: rgba(56,189,248,.3); }
    html[data-theme="dark"] .pcal-day.wfh .ad { color: #bae6fd; }
    html[data-theme="dark"] .pcal-day.hol { background: linear-gradient(160deg, rgba(244,63,94,.62), rgba(244,63,94,.38)); border-color: rgba(251,113,133,.55); }
    html[data-theme="dark"] .pcal-day.hol .ad { color: #fff; }
    html[data-theme="dark"] .pcal-day.hol .bsd { color: #ffe4e6; }
    html[data-theme="dark"] .pcal-day.today { border-color: var(--indigo, #6366f1); box-shadow: inset 0 0 0 1px var(--indigo, #6366f1), 0 0 14px rgba(129,140,248,.45); }
    html[data-theme="dark"] .pcal-day .rm { color: #fbbf24; }
    html[data-theme="dark"] .pcal-day.out { opacity: .32; }
    .lg-we { background: rgba(220,38,38,.35) !important; } .lg-hol { background: rgba(239,68,68,.8) !important; } .lg-wfh { background: rgba(59,130,246,.6) !important; }
    html[data-theme="dark"] .lg-we { background: rgba(251,113,133,.45) !important; } html[data-theme="dark"] .lg-hol { background: #f43f5e !important; } html[data-theme="dark"] .lg-wfh { background: #38bdf8 !important; }
    .pcal-go { display: flex; align-items: center; gap: 6px; margin: 0 0 8px; }
    .pcal-go button { font: inherit; font-size: 11.5px; padding: 3px 10px; border-radius: 7px; border: 1px solid var(--border); background: var(--bg2, transparent); color: var(--text); cursor: pointer; }
    .pcal-go button:hover { border-color: var(--indigo, #6366f1); color: var(--indigo, #6366f1); }
    .pcal-go input { flex: 1; min-width: 0; font: inherit; font-size: 12px; padding: 3px 6px; border-radius: 7px; border: 1px solid var(--border); background: var(--bg2, transparent); color: var(--text); color-scheme: light dark; }
    .pcal-day .ad { font-weight: 700; font-size: 12.5px; line-height: 1.1; }
    .pcal-day .bsd { display: block; font-size: 10px; color: var(--muted); }
    .pcal-day .rm { position: absolute; right: 3px; bottom: 2px; font-size: 9.5px; font-weight: 700; color: var(--amber, #d97706); }
    .pcal-day .n { position: absolute; right: 3px; top: 3px; font-size: 9.5px; font-weight: 700; padding: 0 4px; border-radius: 99px; background: var(--indigo, #6366f1); color: #fff; }
    .pcal-day .n.late { background: var(--amber, #d97706); }
    /* The day the date sits on while a due date is being set (both themes, and
       over a holiday or weekend tint, so the chosen day is never in doubt). */
    .pcal-day.sel, html[data-theme="dark"] .pcal-day.sel { background: var(--indigo, #6366f1); border-color: var(--indigo, #6366f1); box-shadow: 0 0 0 2px rgba(99,102,241,.35); }
    .pcal-day.sel .ad, .pcal-day.sel .bsd, .pcal-day.sel .rm,
    html[data-theme="dark"] .pcal-day.sel .ad, html[data-theme="dark"] .pcal-day.sel .bsd, html[data-theme="dark"] .pcal-day.sel .rm { color: #fff; }
    .pcal-day.sel .n, html[data-theme="dark"] .pcal-day.sel .n { background: #fff; color: var(--indigo, #6366f1); }
    .pcal-legend { display: flex; flex-wrap: wrap; gap: 10px; margin: 8px 0 4px; font-size: 11px; color: var(--muted); }
    .pcal-legend i { display: inline-block; width: 10px; height: 10px; border-radius: 3px; margin-right: 4px; vertical-align: -1px; }
    .pcal-ev { margin-top: 8px; border-top: 1px solid var(--border); padding-top: 8px; display: grid; gap: 4px; }
    .pcal-ev button { display: flex; align-items: center; gap: 6px; width: 100%; text-align: left; font: inherit; color: var(--text); background: none; border: 0; border-radius: 6px; padding: 4px 6px; cursor: pointer; }
    .pcal-ev button:hover { background: var(--bg2, rgba(99,102,241,.08)); color: var(--indigo, #6366f1); }
    .pcal-ev small { color: var(--muted); margin-left: auto; white-space: nowrap; }
    .pcal-ev button.grp { align-items: flex-start; }
    .pcal-ev .gt { line-height: 1.5; font-size: 12px; }
    .pcal-ev .gt b { font-weight: 700; }
    .pcal-ev .gt span, .pcal-ev .gt b + b { white-space: nowrap; }
    .pcal-ev .pcal-more { justify-content: center; color: var(--muted); font-size: 11.5px; }
    .pcal-ev { max-height: 190px; overflow: auto; }
    .pcal-day .fd { position: absolute; left: 5px; bottom: 4px; width: 6px; height: 6px; border-radius: 50%; background: #d97706; }
    .pcal-hint { color: var(--muted); font-size: 11px; margin-top: 6px; }
    /* The time row for a date+time field. Selects and real buttons, big enough
       to hit in the 360px popup - the thing the browser's hh:mm segments were
       not, once the calendar had to swallow the click. */
    .pcal-time { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin: 8px 0 0; padding-top: 8px; border-top: 1px solid var(--border); }
    .pcal-time b { font-size: 11.5px; color: var(--muted); font-weight: 600; }
    .pcal-time select { font: inherit; font-size: 12.5px; padding: 4px 6px; border-radius: 7px; border: 1px solid var(--border); background: var(--bg2, transparent); color: var(--text); cursor: pointer; }
    .pcal-time button { font: inherit; font-size: 11.5px; padding: 4px 9px; border-radius: 7px; border: 1px solid var(--border); background: var(--bg2, transparent); color: var(--text); cursor: pointer; }
    .pcal-time button:hover { border-color: var(--indigo, #6366f1); color: var(--indigo, #6366f1); }
    .pcal-time .ampm { min-width: 44px; font-weight: 600; }
    .pcal-time .set { margin-left: auto; border-color: var(--indigo, #6366f1); background: var(--indigo, #6366f1); color: #fff; font-weight: 600; }
    .pcal-time .set:hover { color: #fff; filter: brightness(1.08); }
    .pcal-quick { display: flex; gap: 5px; flex-wrap: wrap; margin: 6px 0 0; }
    .pcal-quick button { font: inherit; font-size: 11px; padding: 3px 8px; border-radius: 999px; border: 1px solid var(--border); background: transparent; color: var(--muted); cursor: pointer; }
    .pcal-quick button:hover, .pcal-quick button.on { border-color: var(--indigo, #6366f1); color: var(--indigo, #6366f1); }
    /* In a short popup the month can outgrow the popover and it scrolls. The
       time row must never be the part that scrolls away: Set is the only way to
       commit a time, so it stays pinned to the bottom with the grid moving
       under it. The negative bottom/margin reach under the popover's padding so
       nothing shows through below it. */
    .pcal-timew { position: sticky; bottom: -12px; margin-bottom: -12px; padding-bottom: 12px; background: var(--card); }
  `;
  document.head.appendChild(css);

  let pop = null, view = null, picker = null;
  let picks = new Set(), pickMode = false; // days picked to list together (kept while moving between months)
  let rangeCb = null; // open(anchor, { onRange, onDays }): who gets the picked days (else the Tasks list)
  let jump = null; // the month / year chooser: { y } (AD or BS year) while open
  const el = (tag, cls, text) => { const x = document.createElement(tag); if (cls) x.className = cls; if (text != null) x.textContent = text; return x; };
  // Closing without a day being chosen tells whoever opened it for picking that
  // nothing was picked, so it can put its chip back.
  const close = () => {
    const p = picker;
    picker = null;
    if (pop) { pop.remove(); pop = null; }
    if (p && p.onClose) { try { p.onClose(); } catch (e) {} }
  };
  // A day (or "no due date") chosen while the calendar is being used to set a date.
  // In time mode the chosen time rides along as the second argument.
  function choose(ms) {
    const p = picker;
    picker = null; // not a cancel: close() must not call onClose
    close();
    if (p && p.onPick) { try { p.onPick(ms, p.time ? p.hhmm : undefined, p.multi && p.picks.size ? [...p.picks].sort() : undefined); } catch (e) {} }
  }
  document.addEventListener("click", (e) => {
    if (!pop || pop.contains(e.target)) return;
    if (e.target.closest && e.target.closest(".pcal-chip")) return;
    // The thing the calendar was opened from (a task's due date) counts as inside it.
    if (picker && picker.anchor && picker.anchor.contains(e.target)) return;
    close();
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });

  // The month to show starting from a day: its English month, or in Nepali mode
  // the Nepali month it's in.
  function monthOf(ts) {
    const d = new Date(ts);
    if (calMode === "bs") { const b = toBS(d); if (b) return new Date(fromBS(b.y, b.m, 1)); }
    return new Date(d.getFullYear(), d.getMonth(), 1);
  }
  function paintMonth() {
    pop.textContent = "";
    const bsMode = calMode === "bs" && !!toBS(view);
    const y = view.getFullYear(), m = view.getMonth();
    const bv = bsMode ? toBS(view) : null;
    const first = bsMode ? new Date(fromBS(bv.y, bv.m, 1)) : new Date(y, m, 1);
    const last = bsMode ? new Date(fromBS(bv.y, bv.m, bsMonthLen(bv.y, bv.m))) : new Date(y, m + 1, 0);
    const head = el("div", "pcal-head");
    const prev = el("button"); prev.type = "button"; prev.title = "Previous month"; prev.setAttribute("aria-label", "Previous month");
    const next = el("button"); next.type = "button"; next.title = "Next month"; next.setAttribute("aria-label", "Next month");
    prev.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg>';
    next.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 18l6-6-6-6"/></svg>';
    const step = (n) => {
      if (!bsMode) return new Date(y, m + n, 1);
      let yy = bv.y, mm = bv.m + n;
      if (mm < 1) { mm = 12; yy--; } else if (mm > 12) { mm = 1; yy++; }
      return new Date(fromBS(yy, mm, 1) || view.getTime());
    };
    prev.onclick = (e) => { e.stopPropagation(); view = step(-1); paintMonth(); };
    next.onclick = (e) => { e.stopPropagation(); view = step(1); paintMonth(); };
    const t = el("div", "t");
    if (bsMode) {
      t.appendChild(el("b", "", BS_NAMES[bv.m - 1] + " " + bv.y));
      const f = first.toLocaleDateString(undefined, { month: "short" }), l = last.toLocaleDateString(undefined, { month: "short", year: "numeric" });
      t.appendChild(el("span", "", f + " \u2013 " + l));
    } else {
      t.appendChild(el("b", "", first.toLocaleDateString(undefined, { month: "long", year: "numeric" })));
      const bA = toBS(first), bB = toBS(last);
      if (bA && bB) t.appendChild(el("span", "", BS_NAMES[bA.m - 1] + (bA.m !== bB.m || bA.y !== bB.y ? " \u2013 " + BS_NAMES[bB.m - 1] : "") + " " + bB.y));
    }
    // English / Nepali months - remembered on every page.
    const modeSw = el("div", "pcal-mode");
    for (const [k, lab, tip] of [["ad", "AD", "English months"], ["bs", "BS", "Nepali months (Bikram Sambat)"]]) {
      const mb = el("button", calMode === k ? "on" : "", lab); mb.type = "button"; mb.title = tip;
      mb.onclick = (e) => { e.stopPropagation(); if (calMode === k) return; const keep = first.getTime() + 15 * 86400000; calMode = k; try { chrome.storage.local.set({ calMode: k }); } catch (x) {} view = monthOf(Math.min(keep, last.getTime())); paintMonth(); };
      modeSw.appendChild(mb);
    }
    t.appendChild(modeSw);
    head.append(prev, t, next);
    if (rangeCb && rangeCb.title && !picker) { const tl = el("div", "pcal-for", rangeCb.title); pop.appendChild(tl); }
    pop.appendChild(head);
    // Any month in two clicks: the title opens 12 months and the year.
    const tb = t.querySelector("b");
    if (tb) {
      tb.classList.add("pcal-jumpt");
      tb.title = "Pick a month and year";
      tb.setAttribute("role", "button");
      tb.tabIndex = 0;
      const toggleJump = (e) => { e.stopPropagation(); jump = jump ? null : { y: bsMode ? bv.y : y, mode: bsMode ? "bs" : "ad" }; paintMonth(); };
      tb.onclick = toggleJump;
      tb.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleJump(e); } };
    }
    if (jump && jump.mode !== (bsMode ? "bs" : "ad")) jump = { y: bsMode ? bv.y : y, mode: bsMode ? "bs" : "ad" }; // switched AD <-> BS while open
    if (jump) {
      const jp = el("div", "pcal-jump");
      const yr = el("div", "pcal-jy");
      const yb = el("button"); yb.type = "button"; yb.title = "Previous year"; yb.setAttribute("aria-label", "Previous year"); yb.onclick = (e) => { e.stopPropagation(); jump.y--; paintMonth(); };
      const ya = el("button"); ya.type = "button"; ya.title = "Next year"; ya.setAttribute("aria-label", "Next year"); ya.onclick = (e) => { e.stopPropagation(); jump.y++; paintMonth(); };
      yb.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg>';
      ya.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 18l6-6-6-6"/></svg>';
      yr.append(yb, el("b", "", String(jump.y) + (bsMode ? " BS" : "")), ya);
      jp.appendChild(yr);
      const mg = el("div", "pcal-jm");
      const names = bsMode ? BS_NAMES : Array.from({ length: 12 }, (_, i2) => new Date(2000, i2, 1).toLocaleDateString(undefined, { month: "short" }));
      names.forEach((nm, i2) => {
        const target = bsMode ? fromBS(jump.y, i2 + 1, 1) : new Date(jump.y, i2, 1).getTime();
        const b2 = el("button", (bsMode ? bv.y === jump.y && bv.m === i2 + 1 : y === jump.y && m === i2) ? "on" : "", bsMode ? nm.slice(0, 5) : nm);
        b2.type = "button";
        if (!target) { b2.disabled = true; b2.title = "Outside the Nepali calendar the extension knows"; }
        b2.onclick = (e) => { e.stopPropagation(); if (!target) return; view = new Date(target); jump = null; paintMonth(); };
        mg.appendChild(b2);
      });
      jp.appendChild(mg);
      pop.appendChild(jp);
    }
    // Jump to any date: Today, or pick one (the month opens and the day is pointed at).
    // While a date is being set, those are replaced by the quick choices - the
    // browser's own date box would open a second, plain calendar inside ours.
    const go = el("div", "pcal-go");
    if (picker) {
      // In time mode these pick the DAY and leave the time row open, same as a
      // day in the grid - otherwise "Tomorrow" would commit 9:00 and close.
      const quick = (lab, ts, tip) => { const b = el("button", "", lab); b.type = "button"; b.title = tip; b.onclick = (e) => { e.stopPropagation(); if (picker.time) { picker.sel = ymd(ts); goTo(picker.sel); return; } choose(ts); }; return b; };
      const t0 = new Date(); t0.setHours(0, 0, 0, 0);
      const t1 = new Date(t0); t1.setDate(t1.getDate() + 1);
      go.append(quick("Today", t0.getTime(), "Set the " + picker.what + " to today"), quick("Tomorrow", t1.getTime(), "Set the " + picker.what + " to tomorrow"));
      if (picker.canClear) {
        const c = el("button", "", "No " + picker.what); c.type = "button";
        c.title = "Take the " + picker.what + " off";
        c.onclick = (e) => { e.stopPropagation(); choose(null); };
        go.appendChild(c);
      }
      const now = el("span", "", picker.sel ? "now " + fmtShort(parseYmd(picker.sel)) + (picker.time ? ", " + fmtTime12(picker.hhmm) : "") : "no " + picker.what + " yet");
      now.style.cssText = "margin-left:auto;color:var(--muted);font-size:11.5px;white-space:nowrap";
      go.appendChild(now);
    } else {
      const todayBtn = el("button", "", "Today"); todayBtn.type = "button";
      todayBtn.onclick = (e) => { e.stopPropagation(); goTo(ymd(Date.now())); };
      // A date typed in: AD (2026-10-23) or, in Nepali months, BS (2083-07-06).
      const jumpIn = el("input"); jumpIn.type = "text"; jumpIn.dataset.pcalJump = "1"; jumpIn.spellcheck = false;
      const pad2 = (n) => String(n).padStart(2, "0");
      jumpIn.value = bsMode ? bv.y + "-" + pad2(bv.m) + "-01" : ymd(first.getTime());
      jumpIn.placeholder = bsMode ? "2083-07-06 (BS)" : "2026-10-23";
      jumpIn.title = bsMode ? "Go to a Nepali date: year-month-day (BS), then Enter" : "Go to a date: year-month-day, then Enter";
      const goTyped = () => {
        const mm = /^\s*(\d{4})\s*[-\/.]\s*(\d{1,2})\s*[-\/.]\s*(\d{1,2})\s*$/.exec(jumpIn.value || "");
        if (!mm) { jumpIn.classList.add("bad"); return; }
        const ts = bsMode ? fromBS(+mm[1], +mm[2], +mm[3]) : new Date(+mm[1], +mm[2] - 1, +mm[3]).getTime();
        if (!ts) { jumpIn.classList.add("bad"); return; }
        goTo(ymd(ts));
      };
      jumpIn.onkeydown = (e) => { e.stopPropagation(); jumpIn.classList.remove("bad"); if (e.key === "Enter") { e.preventDefault(); goTyped(); } };
      jumpIn.onchange = (e) => { e.stopPropagation(); goTyped(); };
      jumpIn.onclick = (e) => e.stopPropagation();
      go.append(todayBtn, jumpIn);
    }
    pop.appendChild(go);
    const grid = el("div", "pcal-grid");
    for (const w of ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]) grid.appendChild(el("div", "pcal-wd", w));
    const counts = dueCounts();
    const todayK = ymd(Date.now());
    const start = new Date(first.getFullYear(), first.getMonth(), first.getDate() - first.getDay());
    const inMonth = (d) => d.getTime() >= first.getTime() && d.getTime() <= last.getTime();
    for (let i = 0; i < 42; i++) {
      const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
      if (i >= 35 && !inMonth(d)) break;
      const k = ymd(d), ts = d.getTime();
      const b = el("button", "pcal-day"); b.type = "button";
      if (!inMonth(d)) b.classList.add("out");
      const weekend = d.getDay() === 0 || d.getDay() === 6;
      b.dataset.k = k;
      if (k === todayK) b.classList.add("today");
      if (picker && picker.sel === k && !(picker.multi && picker.picks.size)) b.classList.add("sel");
      if (picker && picker.multi) {
        b.classList.add("mt");
        const on = picker.picks.has(k);
        if (on) b.classList.add("pick");
        const tk = el("span", "tk", on ? "\u2713" : "");
        tk.title = on ? "Untick this day" : "Tick this day too (several days)";
        b.appendChild(tk);
      }
      const evs = eventsOn(ts);
      if (evs.some((e) => e.kind === "holiday")) b.classList.add("hol");
      else if (weekend) b.classList.add("we");
      else if (evs.some((e) => e.kind === "wfh")) b.classList.add("wfh");
      const bs = toBS(d);
      if (bsMode && bs) {
        // Nepali month: its day big, the English date small.
        b.appendChild(el("span", "ad", String(bs.d)));
        b.appendChild(el("span", "bsd", d.getDate() === 1 ? d.toLocaleDateString(undefined, { month: "short" }) + " 1" : String(d.getDate())));
      } else {
        b.appendChild(el("span", "ad", String(d.getDate())));
        if (bs) b.appendChild(el("span", "bsd", bs.d === 1 ? BS_NAMES[bs.m - 1].slice(0, 3) + " 1" : String(bs.d)));
      }
      const fest = festivalOn(ts);
      if (fest) { b.classList.add("fest"); b.appendChild(fest[3] ? el("span", "fn", fest[1]) : el("span", "fd")); }
      const c = counts.get(k);
      if (c && c.n) { const n = el("span", "n" + (c.open && k < todayK ? " late" : ""), String(c.n)); n.title = c.n + " task" + (c.n === 1 ? "" : "s") + " due" + (c.open ? " (" + c.open + " not done)" : ""); b.appendChild(n); }
      const rms = remindersOn(ts);
      if (rms.length) { const rm = el("span", "rm", "\u23F0" + (rms.length > 1 ? rms.length : "")); b.appendChild(rm); }
      b.title = d.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" }) + (bs ? " \u00b7 " + BS_NAMES[bs.m - 1] + " " + bs.d + ", " + bs.y : "") +
        (fest ? "\n\uD83E\uDE94 " + fest[0] : "") +
        (evs.length ? "\n" + evs.map((e) => icon(e.kind) + " " + e.title + evTime(e) + (e.note ? " - " + e.note : "")).join("\n") : "") + (c && c.n ? "\n" + c.n + " task" + (c.n === 1 ? "" : "s") + " due" : "") +
        (rms.length ? "\n" + rms.map((r) => "\u23F0 " + r.time + "  " + r.text).join("\n") : "") +
        (picker && picker.multi ? (picker.picks.has(k) ? "\nTicked - click to untick" : picker.picks.size ? "\nClick to tick this day too" : "\nClick to use this day - or tick its box (or Ctrl+click) to pick several days") : picker ? (picker.sel === k ? "\nThe " + picker.what + " now" : picker.time ? "\nClick to use this day, then set the time below" : "\nClick to make this the " + picker.what) : "\nClick to list this day's tasks - or drag across days (a week...) to list them all");
      if (!picker && (pickMode || picks.size)) {
        const on = picks.has(k);
        if (on) b.classList.add("pick");
        if (pickMode) { b.classList.add("mt"); b.appendChild(el("span", "tk", on ? "\u2713" : "")); }
      }
      b.onclick = picker
        ? (e) => {
            e.stopPropagation();
            // Several days: the tick box, Ctrl/Cmd+click, or any click once a day
            // is ticked toggles that day. Ticks stay while moving between months.
            if (picker.multi && (picker.picks.size || e.ctrlKey || e.metaKey || (e.target && e.target.closest && e.target.closest(".tk")))) {
              if (!picker.picks.size && picker.sel && picker.sel !== k) picker.picks.add(picker.sel); // the day already chosen joins in
              if (picker.picks.has(k)) picker.picks.delete(k); else picker.picks.add(k);
              const first = [...picker.picks].sort()[0];
              if (first) picker.sel = first;
              paintMonth();
              return;
            }
            // With a time to set as well, clicking a day only MOVES the
            // selection: the time row stays open so the time can still be
            // changed afterwards, and Set is what commits both.
            if (picker.time) { picker.sel = k; goTo(k); return; }
            choose(ts);
          }
        : (e) => {
            e.stopPropagation();
            if (pickMode) { if (picks.has(k)) picks.delete(k); else picks.add(k); paintMonth(); return; } // picking: tick / untick
            close(); sendDay(ts);
          };
      grid.appendChild(b);
    }
    pop.appendChild(grid);
    // Several days at once - nothing changes until "List" is pressed (a drag let
    // go by mistake used to switch the list at once):
    //  - drag across days (a week, Mon to Fri...) to pick them;
    //  - "Pick days" ticks any days, in any months (the ticks stay while moving);
    //  - "List all of <month>".
    // One read from ClickUp for the span (up to ~3 months), filtered to the days.
    if (!picker && (rangeCb || typeof window.pcmPickRange === "function")) {
      let from = "", to = "", moved = false, removing = false;
      const span = () => (from <= to ? [from, to] : [to, from]);
      const paintRng = () => {
        const [a, z] = span();
        grid.querySelectorAll(".pcal-day[data-k]").forEach((c) => {
          const inR = moved && c.dataset.k >= a && c.dataset.k <= z;
          c.classList.toggle("rng", inR && !removing);
          c.classList.toggle("rng-off", inR && removing);
        });
      };
      const end = () => {
        if (!from) return;
        const [a, z] = span(), was = moved;
        from = to = ""; moved = false;
        if (!was) return; // a plain click: handled by the day itself
        // Started on a picked day: the dragged days come OFF; otherwise they go on.
        const keep = removing || (picks.size && pickMode) ? picks : new Set();
        for (let d = parseYmd(a); d <= parseYmd(z); d += 86400000) { const k2 = ymd(d + 3600000); if (removing) keep.delete(k2); else keep.add(k2); } // (+1h: a DST day stays the same date)
        picks = keep;
        removing = false;
        paintMonth();
      };
      grid.addEventListener("pointerdown", (e) => {
        const c = e.target.closest && e.target.closest(".pcal-day[data-k]");
        if (!c || e.button !== 0) return;
        from = to = c.dataset.k; moved = false;
        removing = picks.has(c.dataset.k); // drag from a ticked day = untick the span
        document.addEventListener("pointerup", end, { once: true });
      });
      grid.addEventListener("pointerover", (e) => {
        if (!from) return;
        const c = e.target.closest && e.target.closest(".pcal-day[data-k]");
        if (!c || c.dataset.k === to) return;
        to = c.dataset.k; moved = to !== from; paintRng();
      });
      grid.classList.add("pcal-drag");
      const row = el("div", "pcal-rangebar");
      if (picks.size) {
        const list = [...picks].sort(), a = list[0], z = list[list.length - 1];
        const days = Math.round((parseYmd(z) - parseYmd(a)) / 86400000) + 1;
        const together = days === list.length;
        const fmtS = (k) => new Date(parseYmd(k)).toLocaleDateString(undefined, { month: "short", day: "numeric" });
        const lab = el("b", "", together ? (list.length === 1 ? fmtS(a) : fmtS(a) + " \u2013 " + fmtS(z)) + " \u00b7 " + list.length + " day" + (list.length === 1 ? "" : "s") : list.length + " days picked (" + fmtS(a) + " \u2026 " + fmtS(z) + ")");
        const go = el("button", "pri", together && list.length > 1 ? "List these tasks" : "List " + list.length + " day" + (list.length === 1 ? "" : "s"));
        go.type = "button";
        const clr = el("button", "", "Clear"); clr.type = "button";
        clr.onclick = (e) => { e.stopPropagation(); picks = new Set(); paintMonth(); };
        if (days > 93) { go.disabled = true; go.title = "Up to about 3 months at a time - pick days closer together"; }
        go.onclick = (e) => {
          e.stopPropagation();
          const sel = [...picks].sort();
          picks = new Set(); pickMode = false;
          close();
          if (together) sendRange(parseYmd(sel[0]), parseYmd(sel[sel.length - 1]));
          else sendDays(sel.map(parseYmd));
        };
        row.classList.add("on");
        row.append(lab, go, clr);
      } else {
        row.append(el("span", "", "Several days? Drag across them, or"));
      }
      const pm = el("button", pickMode ? "on" : "", pickMode ? "\u2611 Picking days" : "\u2610 Pick days");
      pm.type = "button";
      pm.title = pickMode ? "Click days (any month) to tick or untick them, then List - click here to stop picking" : "Tick any days you like, in any months, then list their tasks together";
      pm.onclick = (e) => { e.stopPropagation(); pickMode = !pickMode; paintMonth(); };
      const mb = el("button", "", "All of " + (bsMode ? BS_NAMES[bv.m - 1] : first.toLocaleDateString(undefined, { month: "long" })));
      mb.type = "button";
      mb.title = "Every task due this month (one read from ClickUp)";
      mb.onclick = (e) => { e.stopPropagation(); picks = new Set(); pickMode = false; close(); sendRange(first.getTime(), last.getTime()); };
      row.append(pm, mb);
      pop.appendChild(row);
    }

    if (picker && picker.multi) {
      const ml = el("div", "pcal-multi");
      const list = [...picker.picks].sort();
      if (list.length) {
        ml.append(el("b", "", list.length + " day" + (list.length === 1 ? "" : "s") + " ticked: "), list.map((k) => fmtShort(parseYmd(k))).join(", "));
        const clr = el("button", "", "Clear ticks"); clr.type = "button";
        clr.onclick = (e) => { e.stopPropagation(); picker.picks.clear(); paintMonth(); };
        ml.appendChild(clr);
      } else ml.textContent = "Several days? Tick their boxes (or Ctrl+click them) - any month, then set the time once.";
      pop.appendChild(ml);
    }
    if (picker && picker.time) pop.appendChild(timeRow());
    const lg = el("div", "pcal-legend");
    lg.innerHTML = '<span>\u23F0 Reminder</span><span><i class="lg-we"></i>Weekend</span><span><i class="lg-hol"></i>Holiday</span><span><i class="lg-wfh"></i>Work from home</span><span><i style="background:#d97706;border-radius:50%"></i>Festival</span><span><i style="background:var(--indigo,#6366f1)"></i>Tasks due</span>';
    pop.appendChild(lg);
    // Company days in this month and the next few weeks.
    const fromK = ymd(first.getTime()), toK = ymd(new Date(last.getFullYear(), last.getMonth() + 1, last.getDate()).getTime());
    // Named days (festivals) in the same weeks, listed with the office's days.
    const groups = new Map();
    const singles = [];
    for (const [k, v] of Object.entries(festivals())) {
      if (k < fromK || k > toK) continue;
      if (!v[2]) { singles.push({ from: k, to: k, kind: "fest", title: v[0] }); continue; }
      if (!groups.has(v[2])) groups.set(v[2], []);
      groups.get(v[2]).push([k, v]);
    }
    const fests = singles.concat([...groups].map(([g, days]) => {
      days.sort((a, b) => a[0].localeCompare(b[0]));
      return { from: days[0][0], to: days[days.length - 1][0], kind: "fest", title: g, days };
    }));
    const all = company.filter((e) => e.kind !== "festival" && (e.to || e.from) >= fromK && e.from <= toK).concat(fests).sort((a, b) => a.from.localeCompare(b.from));
    // Only what's still ahead, unless the whole month is in the past; the rest
    // folds into "Show earlier".
    const past = all.filter((e) => (e.to || e.from) < todayK && toK >= todayK);
    const list = all.filter((e) => !past.includes(e));
    if (list.length || past.length) {
      const ev = el("div", "pcal-ev");
      const addRow = (e) => {
        const row = el("button"); row.type = "button";
        row.title = "Show where it starts (" + fmtShort(parseYmd(e.from)) + ")";
        if (e.days) {
          // A festival group on one line: its days with their dates, the main ones bold.
          row.classList.add("grp");
          const tx = el("span", "gt");
          tx.append(icon("fest") + " ", el("b", "", e.title));
          for (const [k, v] of e.days) {
            tx.append(" \u00b7 ");
            const dn = el(v[3] ? "b" : "span", "", v[1] + " " + new Date(parseYmd(k)).getDate());
            dn.title = v[0] + " - " + fmtShort(parseYmd(k));
            tx.appendChild(dn);
          }
          row.appendChild(tx);
          row.title = e.days.map(([k, v]) => fmtShort(parseYmd(k)) + "  " + v[0]).join("\n");
          row.onclick = (ev2) => { ev2.stopPropagation(); goTo(e.from); };
          ev.appendChild(row);
          return;
        }
        row.append(icon(e.kind) + " " + e.title + evTime(e));
        if (e.note) row.title = e.note + "\n" + row.title;
        row.appendChild(el("small", "", fmtShort(parseYmd(e.from)) + (e.to && e.to !== e.from ? " \u2013 " + fmtShort(parseYmd(e.to)) : "")));
        row.onclick = (ev2) => { ev2.stopPropagation(); goTo(e.from); };
        ev.appendChild(row);
      };
      for (const e of list) addRow(e);
      if (past.length) {
        const more = el("button", "pcal-more", "Show earlier (" + past.length + ")"); more.type = "button";
        more.onclick = (ev2) => { ev2.stopPropagation(); more.remove(); for (const e of past) addRow(e); };
        ev.appendChild(more);
      }
      pop.appendChild(ev);
    }
    pop.appendChild(el("div", "pcal-hint", picker
      ? (picker.time
        ? "Click a day, set the time below, then press Set. Red = holiday, blue = work from home, the number on a day is how many tasks are already due then. Esc keeps what it has."
        : "Click a day to make it the " + picker.what + ". Red = holiday, blue = work from home, the number on a day is how many tasks are already due then. Esc keeps the date it has.")
      : "Task counts: all your open tasks, any month (and the done ones in the weeks loaded)."));
  }
  // The time row, for a field that carries a time as well as a day. Plain
  // selects and buttons: the point is that every part can be CLICKED, which the
  // browser's own hh:mm segments cannot be once the calendar owns the click.
  function timeRow() {
    const wrap = el("div", "pcal-timew");
    const box = el("div", "pcal-time");
    const quick = el("div", "pcal-quick");
    const t = to12(picker.hhmm);
    box.appendChild(el("b", "", "Time"));
    const hSel = el("select"); hSel.title = "Hour";
    for (let h = 1; h <= 12; h++) { const o = el("option", "", String(h)); o.value = String(h); hSel.appendChild(o); }
    hSel.value = String(t.h12);
    const mSel = el("select"); mSel.title = "Minutes";
    const mins = [];
    for (let m = 0; m < 60; m++) mins.push(m); // every minute (5-minute steps made 8:07 impossible)
    if (!mins.includes(t.min)) mins.push(t.min); // an odd minute already set is kept, not rounded away
    mins.sort((a, b) => a - b);
    for (const m of mins) { const o = el("option", "", String(m).padStart(2, "0")); o.value = String(m); mSel.appendChild(o); }
    mSel.value = String(t.min);
    const ap = el("button", "ampm", t.pm ? "PM" : "AM"); ap.type = "button"; ap.title = "Switch between AM and PM";
    const set = el("button", "set", "Set"); set.type = "button";
    const sync = () => {
      picker.hhmm = from12(hSel.value, mSel.value, ap.textContent === "PM");
      const day = picker.sel ? parseYmd(picker.sel) : 0;
      set.textContent = picker.multi && picker.picks.size > 1 ? "Set " + picker.picks.size + " days, " + fmtTime12(picker.hhmm) : "Set " + (day ? fmtShort(day) + ", " : "") + fmtTime12(picker.hhmm);
      set.title = "Use this " + picker.what;
      quick.querySelectorAll("button").forEach((q) => q.classList.toggle("on", q.dataset.t === picker.hhmm));
    };
    hSel.onchange = sync; mSel.onchange = sync;
    hSel.onclick = (e) => e.stopPropagation();
    mSel.onclick = (e) => e.stopPropagation();
    ap.onclick = (e) => { e.stopPropagation(); ap.textContent = ap.textContent === "PM" ? "AM" : "PM"; sync(); };
    set.onclick = (e) => { e.stopPropagation(); choose(picker.sel ? parseYmd(picker.sel) : Date.now()); };
    box.append(hSel, el("span", "", ":"), mSel, ap, set);
    for (const hhmm of ["09:00", "12:00", "14:00", "17:00"]) {
      const q = el("button", "", fmtTime12(hhmm)); q.type = "button"; q.dataset.t = hhmm;
      q.title = "Set the time to " + fmtTime12(hhmm);
      q.onclick = (e) => {
        e.stopPropagation();
        const p = to12(hhmm);
        hSel.value = String(p.h12); mSel.value = String(p.min); ap.textContent = p.pm ? "PM" : "AM";
        sync();
      };
      quick.appendChild(q);
    }
    wrap.append(box, quick);
    sync();
    return wrap;
  }
  // Show the month of a date and point at that day.
  function goTo(k) {
    view = monthOf(parseYmd(k));
    paintMonth();
    const cell = pop && pop.querySelector('.pcal-day[data-k="' + k + '"]');
    if (cell) { cell.classList.add("flash"); cell.focus({ preventScroll: true }); }
  }
  // Sit under whatever was clicked, or above it when there's no room below.
  function place(anchor) {
    const r = anchor.getBoundingClientRect();
    const w = pop.offsetWidth, h = pop.offsetHeight;
    let top = r.bottom + 6;
    if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 6);
    // Neither below nor above fits in a short popup: sit it as low as it can go
    // and let it scroll (max-height keeps h within the window), rather than
    // leaving the bottom - the time row and Set - off the screen.
    top = Math.min(top, Math.max(8, window.innerHeight - h - 8));
    pop.style.top = Math.round(top) + "px";
    pop.style.left = Math.round(Math.max(8, Math.min(window.innerWidth - w - 8, r.left))) + "px";
  }
  // Open on the month of a given day.
  function openAt(anchor, ts) {
    pop = el("div", "pcal-pop");
    pop.onclick = (e) => e.stopPropagation();
    pop._anchor = anchor;
    document.body.appendChild(pop);
    view = monthOf(ts || Date.now());
    paintMonth();
    place(anchor);
  }
  // open(anchor, { onRange(fromTs, toTs), onDays([ts...]), title }): the same day /
  // range / Pick days choosing, handed to the caller (Explore tasks) instead of
  // changing the Tasks list's filter.
  function open(anchor, opts) {
    close();
    rangeCb = opts && (opts.onRange || opts.onDays) ? opts : null;
    openAt(anchor, Date.now());
    freshOpen();
  }
  function sendRange(a, z) {
    const cb = rangeCb; rangeCb = null;
    if (cb && cb.onRange) cb.onRange(a, z); else if (typeof window.pcmPickRange === "function") window.pcmPickRange(a, z);
  }
  function sendDays(list) {
    const cb = rangeCb; rangeCb = null;
    if (cb && cb.onDays) cb.onDays(list); else if (typeof window.pcmPickDays === "function") window.pcmPickDays(list);
  }
  function sendDay(ts) {
    const cb = rangeCb; rangeCb = null;
    if (cb && cb.onRange) cb.onRange(ts, ts); else if (typeof window.pcmPickDay === "function") window.pcmPickDay(ts);
  }
  // It's fixed on the screen, so it follows what it was opened from while the
  // page scrolls, and gets out of the way if that is redrawn away under it
  // (the task lists refresh on their own).
  for (const ev of ["scroll", "resize"]) {
    window.addEventListener(ev, () => {
      if (!pop || !pop._anchor) return;
      if (!pop._anchor.isConnected) close();
      else place(pop._anchor);
    }, { capture: true, passive: true });
  }
  // The same calendar, used to SET a date instead of browsing it: the holidays,
  // the work-from-home days and how many tasks are already due on a day are all
  // in front of you, so a due date isn't a guess.
  // opts: { value: ms (the date it has now), canClear, onPick(dayMs|null, hhmm?), onClose(), what ("due date" unless said: "start date"…),
  //         time (the field carries a time too -> show the time row), timeValue ("HH:MM" it has now) }
  function pickDate(anchor, opts) {
    close(); // whatever was open is a cancel, and its onClose runs before ours is set
    const o = opts || {};
    picker = { sel: o.value ? ymd(o.value) : "", canClear: !!o.canClear, what: String(o.what || "due date"), anchor, onPick: o.onPick, onClose: o.onClose,
      time: !!o.time, hhmm: hhmmOf(o.timeValue) || "09:00",
      multi: !!o.multi, picks: new Set((Array.isArray(o.days) ? o.days : []).filter((k) => /^\d{4}-\d{2}-\d{2}$/.test(String(k)))) };
    if (picker.picks.size) picker.sel = [...picker.picks].sort()[0];
    openAt(anchor, o.value || Date.now());
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
      const g = await chrome.storage.local.get(["companyCalendar", "clickupState", "reminders", "insOpenCache"]);
      openAll = g.insOpenCache && Array.isArray(g.insOpenCache.tasks) ? g.insOpenCache : openAll;
      company = Array.isArray(g.companyCalendar) ? g.companyCalendar : [];
      reminders = Array.isArray(g.reminders) ? g.reminders : [];
      state = g.clickupState || null;
    } catch (e) {}
    paintChip();
    if (pop) paintMonth();
  }
  try { chrome.storage.onChanged.addListener((ch, area) => { if (area === "local" && (ch.companyCalendar || ch.clickupState || ch.reminders || ch.insOpenCache)) load(); }); } catch (e) {}
  try { chrome.storage.onChanged.addListener((ch, area) => { if (area === "local" && ch.calMode && (ch.calMode.newValue === "bs" || ch.calMode.newValue === "ad")) calMode = ch.calMode.newValue; }); } catch (e) {}
  setInterval(paintChip, 60000); // the date rolls over at midnight
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", load); else load();
  // ---- every date field on the page uses THIS calendar ----
  // A date (or date + time) field anywhere - filters, Bulk edit, Wrap up, Add
  // missed time, reminders, notices - opens this calendar instead of the
  // browser's plain one: clicking it, Enter / Space / Alt+Down in it, or a page
  // calling its showPicker(). The pick is written back as the field's normal
  // value with input + change events, so the page's own code works unchanged.
  // Date + time fields keep their time (typed as before). The browser's own
  // calendar button is hidden on them.
  const DATE_SEL = 'input[type="date"]:not([data-pcal-jump]), input[type="datetime-local"]';
  const takeCss = document.createElement("style");
  takeCss.textContent = DATE_SEL.split(", ").map((s) => s + "::-webkit-calendar-picker-indicator").join(", ") + " { display: none; }\n" +
    "input[data-pcal-jump]::-webkit-calendar-picker-indicator { display: none; }\n" +
    DATE_SEL.split(", ").map((s) => s + ":not(:disabled)").join(", ") + " { cursor: pointer; }";
  document.head.appendChild(takeCss);
  const fieldDay = (inp) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(inp.value || "")); return m ? new Date(+m[1], +m[2] - 1, +m[3], 12).getTime() : 0; };
  function pickFor(inp, anchor) {
    if (!inp || inp.disabled || inp.readOnly) return;
    const withTime = inp.type === "datetime-local";
    // A hidden field behind a button ("Move all to date…") is an action, not a
    // value to clear; a field you can see may be emptied ("No date").
    const hidden = inp.offsetWidth < 4 || inp.offsetHeight < 4 || getComputedStyle(inp).opacity === "0";
    pickDate(anchor && anchor.isConnected ? anchor : inp, {
      value: fieldDay(inp) || 0,
      canClear: !inp.required && !hidden,
      what: inp.dataset.pcalWhat || (withTime ? "day" : "date"),
      time: withTime,
      timeValue: (/T(\d{1,2}:\d{2})/.exec(String(inp.value || "")) || [])[1] || "09:00",
      // data-pcal-multi: several days may be ticked; they come back in
      // data-pcal-days ("2026-10-17,2026-10-19"), the first one as the value.
      multi: inp.dataset.pcalMulti === "1",
      days: inp.dataset.pcalMulti === "1" && inp.dataset.pcalDays ? inp.dataset.pcalDays.split(",") : [],
      onPick: (ms, hhmm, days) => {
        if (inp.dataset.pcalMulti === "1") {
          if (days && days.length > 1) { inp.dataset.pcalDays = days.join(","); ms = parseYmd(days[0]); }
          else delete inp.dataset.pcalDays;
        }
        let v = ms ? ymd(ms) : "";
        if (v && inp.min && v < String(inp.min).slice(0, 10)) return; // before the earliest allowed day
        if (v && inp.max && v > String(inp.max).slice(0, 10)) return;
        // The time comes from the calendar's own time row now. The old fallback
        // (keep whatever was typed, else 9:00) stays for anything that opens the
        // picker without one.
        if (v && withTime) v += "T" + (hhmmOf(hhmm) || (/T(\d{1,2}:\d{2})/.exec(inp.value) || [])[1] || "09:00");
        inp.value = v;
        inp.dispatchEvent(new Event("input", { bubbles: true }));
        inp.dispatchEvent(new Event("change", { bubbles: true }));
      },
      onClose: () => {},
    });
  }
  // What was just pressed: a hidden field opened by a button ("Move all to
  // date…") shows the calendar next to that button.
  let lastPress = null, lastPressAt = 0;
  document.addEventListener("pointerdown", (e) => { lastPress = e.target && e.target.closest ? e.target.closest("button, a, [role=button], label, input") || e.target : null; lastPressAt = Date.now(); }, true);
  document.addEventListener("click", (e) => {
    const inp = e.target && e.target.closest ? e.target.closest(DATE_SEL) : null;
    if (!inp) return;
    e.preventDefault();
    pickFor(inp, inp);
  }, true);
  document.addEventListener("keydown", (e) => {
    const inp = e.target && e.target.matches && e.target.matches(DATE_SEL) ? e.target : null;
    if (!inp || !((e.key === "Enter" || e.key === " ") || (e.altKey && e.key === "ArrowDown"))) return;
    e.preventDefault(); e.stopPropagation();
    pickFor(inp, inp);
  }, true);
  try {
    const native = HTMLInputElement.prototype.showPicker;
    HTMLInputElement.prototype.showPicker = function () {
      if (this.matches && this.matches(DATE_SEL)) {
        const hidden = this.offsetWidth < 4 || this.offsetHeight < 4 || getComputedStyle(this).opacity === "0";
        return pickFor(this, hidden && lastPress && Date.now() - lastPressAt < 1500 ? lastPress : this);
      }
      return native ? native.call(this) : undefined;
    };
  } catch (e) {}
  window.PcmCalendar = { toBS, fromBS, festivalOn, bsLabel, isHoliday, isWfh, eventsOn, remindersOn, open, pick: pickDate, pickFor, refresh: load };
})();
