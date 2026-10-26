// The Automation tab (options page). Hidden until /automation is typed in the
// console (Ctrl+Shift+`), and hidden again with /automation off - storage
// automationTab. It holds:
//  - Rules: WHEN something happens / IF conditions / THEN actions, built from
//    blocks (lib-rules.js; the background runs them), from an example, or
//    from a sentence (AI), with Test, history and Undo;
//  - every console command with how to use it, a box to run them, and what is
//    switched on with its Turn off button (window.PcmConsole from ui-extras.js).
(() => {
  "use strict";
  const nav = document.getElementById("sideNav");
  if (!nav) return; // the options page only
  const $ = (sel, root) => (root || document).querySelector(sel);
  const el = (tag, cls, text) => { const x = document.createElement(tag); if (cls) x.className = cls; if (text != null) x.textContent = text; return x; };
  const send = (msg, ms) => new Promise((ok) => {
    let done = false;
    const to = setTimeout(() => { done = true; ok(null); }, ms || 30000);
    try { chrome.runtime.sendMessage(msg, (r) => { if (done) return; done = true; clearTimeout(to); void chrome.runtime.lastError; ok(r || null); }); } catch (e) { clearTimeout(to); ok(null); }
  });
  const fmtT = (ms) => new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const t12 = (hhmm) => { const [h, m] = String(hhmm || "17:00").split(":").map(Number); return { h12: ((h + 11) % 12) + 1, min: m || 0, pm: h >= 12 }; };
  const from12 = (h12, min, pm) => String((Number(h12) % 12) + (pm ? 12 : 0)).padStart(2, "0") + ":" + String(min).padStart(2, "0");

  const css = el("style");
  css.textContent = `
    .au-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 20px; align-items: start; }
    @media (max-width: 1150px) { .au-grid { grid-template-columns: 1fr; } }
    .au-card { background: var(--card); border: 1px solid var(--border); border-radius: 14px; padding: 18px 20px; }
    .au-card h2 { margin: 0 0 4px; font-size: 17px; }
    .au-card .sub { color: var(--muted); font-size: 12.5px; margin: 0 0 12px; }
    .au-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin: 8px 0; }
    .au-row label { margin: 0; font-weight: 400; display: inline-flex; align-items: center; gap: 6px; }
    .au-row input[type=text], .au-row input[type=password] { flex: 1 1 200px; min-width: 0; padding: 7px 9px; border-radius: 8px; border: 1px solid var(--border); background: var(--field, #fff); color: var(--text); font: inherit; font-size: 13px; }
    .au-time { display: inline-flex; align-items: center; gap: 4px; flex: none; }
    .au-row select, .au-time select { width: auto !important; min-width: 0; flex: none; padding: 5px 6px; border-radius: 7px; border: 1px solid var(--border); background: var(--field, #fff); color: var(--text); font: inherit; font-size: 13px; }
    .au-box { border: 1px solid var(--border); border-radius: 10px; padding: 10px 12px; margin: 12px 0 0; }
    .au-box > b { display: block; margin-bottom: 2px; }
    .au-st { font-size: 12.5px; color: var(--muted); margin: 6px 0 0; }
    .au-st.ok { color: var(--green, #16a34a); }
    .au-st.err { color: var(--red, #dc2626); }
    .au-ahead-tick { font-weight: 600 !important; }
    .au-flow { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin: 10px 0 6px; }
    @media (max-width: 760px) { .au-flow { grid-template-columns: 1fr; } }
    .au-flowcol { border: 1px dashed var(--border); border-radius: 10px; padding: 9px 11px; opacity: .6; transition: opacity .2s; }
    .au-flowcol.now { opacity: 1; border-style: solid; border-color: var(--indigo, #6366f1); background: color-mix(in srgb, var(--indigo, #6366f1) 6%, transparent); }
    .au-flowcol > b { display: block; font-size: 12.5px; margin-bottom: 6px; }
    .au-steps { display: flex; align-items: stretch; gap: 4px; }
    .au-step { flex: 1 1 0; min-width: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 3px; text-align: center; font-size: 11px; line-height: 1.25; padding: 7px 5px; border-radius: 9px; background: var(--card); border: 1px solid var(--border); overflow-wrap: anywhere; }
    .au-step .ic { font-size: 18px; line-height: 1; }
    .au-arrow { color: var(--muted); font-weight: 700; align-self: center; flex: none; }
    .au-flownote { font-size: 11.5px; color: var(--muted); margin-top: 7px; line-height: 1.4; }
    .au-aheadlist { display: grid; gap: 4px; margin-top: 8px; }
    .au-aheadlist > b { font-size: 12.5px; }
    .au-aheadrow { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-size: 12.5px; padding: 3px 0; border-top: 1px dashed var(--border); }
    .au-aheadrow.cx > span:first-child { text-decoration: line-through; opacity: .6; }
    .au-aheadrow.done > span:first-child { opacity: .7; }
    .au-aheadrow button { font-size: 11.5px !important; padding: 2px 8px !important; }
    .au-aheadhelp { line-height: 1.45; margin-top: 8px; }
    .au-days { display: inline-flex; gap: 4px; flex-wrap: wrap; }
    .au-days.off { opacity: .45; }
    .au-day { font-size: 12px !important; padding: 3px 8px !important; border-radius: 999px; border: 1px solid var(--border); background: transparent; color: var(--text); cursor: pointer; }
    .au-day.on { background: var(--indigo, #6366f1); border-color: var(--indigo, #6366f1); color: #fff; }
    .au-dates { display: inline-flex; gap: 6px; flex-wrap: wrap; align-items: center; }
    .au-date { display: inline-flex; align-items: center; gap: 2px; padding: 1px 4px 1px 9px; border-radius: 999px; border: 1px solid var(--border); font-size: 12px; }
    .au-date button { border: 0; background: none; cursor: pointer; padding: 0 4px; color: var(--muted); }
    .au-box input[type=date] { width: auto; padding: 4px 8px; border-radius: 7px; border: 1px solid var(--border); background: var(--field, #fff); color: var(--text); }
    .au-btns { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 8px; }
    .au-btns button, .au-row button { font-size: 12.5px; padding: 5px 11px; }
    .au-pre { white-space: pre-wrap; word-break: break-word; font-size: 12px; line-height: 1.45; background: var(--bg2, rgba(127,127,127,.07)); border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px; margin: 8px 0 0; max-height: 260px; overflow: auto; }
    .au-help { font-size: 12.5px; margin: 10px 0 0; }
    .au-help summary { cursor: pointer; color: var(--indigo); }
    .au-help ol { margin: 6px 0 0; padding-left: 20px; }
    .au-help li { margin: 3px 0; }
    .au-cmds { display: flex; flex-direction: column; gap: 6px; }
    .au-cmd { display: grid; grid-template-columns: 140px minmax(0, 1fr); gap: 4px 10px; align-items: start; border-top: 1px solid var(--border); padding-top: 6px; font-size: 12.5px; }
    .au-cmd code { font-weight: 700; }
    .au-cmd .ab { color: var(--muted); }
    /* name | what it does, then its controls on their own line under the text, so a long description never squeezes into a narrow column */
    .au-cmd > .au-btns { grid-column: 2; margin-top: 2px !important; justify-content: flex-start; }
    .au-cmd > .msg { grid-column: 2; }
    @media (max-width: 700px) { .au-cmd { grid-template-columns: 1fr; } .au-cmd > .au-btns, .au-cmd > .msg { grid-column: 1; } }
    .au-term { background: #0d1117; color: #c9d1d9; border-radius: 10px; margin-top: 10px; font: 12px/1.5 ui-monospace, SFMono-Regular, Consolas, monospace; }
    .au-term .xt-out { height: 220px; overflow: auto; padding: 8px 10px; white-space: pre-wrap; word-break: break-word; }
    .au-term .xt-in { display: flex; gap: 6px; align-items: center; border-top: 1px solid #30363d; padding: 6px 10px; }
    .au-term .xt-in input { flex: 1; background: transparent; border: 0; outline: none; color: inherit; font: inherit; }
    .au-term .cmd { color: #58a6ff; } .au-term .ok { color: #3fb950; } .au-term .e { color: #f85149; } .au-term .mu { color: #8b949e; } .au-term .hl { color: #d2a8ff; }
    .au-act { display: flex; flex-direction: column; gap: 6px; }
    .au-gd .set-line { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin: 4px 0 0; font-size: 13px; }
    .au-gd select { width: auto !important; max-width: 100%; padding: 6px 8px; border-radius: 8px; border: 1px solid var(--border); background: var(--field, #fff); color: var(--text); font: inherit; font-size: 13px; }
    .au-gd .md-ex { margin-top: 8px; border: 1px solid var(--border); border-radius: 10px; padding: 10px 12px; background: var(--card); font-size: 12px; overflow-x: auto; }
    .au-gd .md-ex-h { margin-bottom: 6px; color: var(--text); }
    .au-gd table { width: 100%; border-collapse: collapse; }
    .au-gd th, .au-gd td { padding: 5px 8px; border-bottom: 1px solid var(--border); text-align: center; font-variant-numeric: tabular-nums; }
    .au-gd thead th { font-size: 10.5px; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); font-weight: 700; }
    .au-gd tbody th { text-align: left; font-weight: 500; color: var(--muted); min-width: 9em; }
    .au-gd tbody th small { display: block; font-size: 10.5px; opacity: .85; }
    .au-gd td { color: var(--muted); }
    .au-gd tr.on th { color: var(--text); font-weight: 700; }
    .au-gd tr.on td.v { color: #fff; background: #8b5cf6; font-weight: 700; border-radius: 4px; }
    .au-gd tr.on { box-shadow: inset 3px 0 0 #8b5cf6; }
    .au-gd ul { margin: 8px 0 4px; padding-left: 18px; line-height: 1.5; color: var(--text); }
    .au-gd .how { font-size: 12.5px; color: var(--muted); margin: 6px 0 0; }
    .au-gd .how b { color: var(--text); }
    .au-cmd .au-how { border-style: dashed; }
    .sidenav button[data-tab="automation"] .au-x { margin-left: auto; width: 20px; height: 20px; border-radius: 6px; display: inline-flex; align-items: center; justify-content: center; font-size: 12px; color: var(--muted); opacity: .55; }
    .sidenav button[data-tab="automation"]:hover .au-x { opacity: 1; }
    .sidenav button[data-tab="automation"] .au-x:hover { background: rgba(220,38,38,.12); color: var(--red, #dc2626); opacity: 1; }
    .au-coach { display: flex; align-items: flex-start; gap: 10px; margin: 0 0 12px; padding: 10px 12px; border-radius: 10px; background: rgba(99,102,241,.12); border: 1px solid rgba(99,102,241,.35); font-size: 13px; line-height: 1.45; }
    .au-coach b { color: var(--indigo); }
    .au-coach .sp { flex: 1 1 auto; }
    .au-coach button { flex: 0 0 auto; font-size: 12px; padding: 4px 10px; }
    .au-tm { display: inline-flex; gap: 6px; align-items: center; flex-wrap: wrap; }
    .au-tm input[type=text] { width: 130px !important; flex: none; padding: 4px 7px; border-radius: 7px; border: 1px solid var(--border); background: var(--field, #fff); color: var(--text); font: inherit; font-size: 12.5px; }
    .au-tm label { margin: 0; font-weight: 400; display: inline-flex; gap: 4px; align-items: center; font-size: 12px; }
    .au-cmd .msg { grid-column: 1 / -1; font-size: 12px; color: var(--muted); }
    .au-cmd .msg.ok { color: var(--green, #16a34a); } .au-cmd .msg.e { color: var(--red, #dc2626); }
    .au-hidebox { position: fixed; z-index: 2147483000; width: min(340px, calc(100vw - 16px)); box-sizing: border-box; padding: 12px 14px; border-radius: 12px; border: 1px solid var(--border); background: var(--card, #fff); color: var(--text); box-shadow: 0 14px 34px rgba(0,0,0,.25); font-size: 12.5px; }
    .au-hidebox ul { margin: 6px 0; padding-left: 18px; line-height: 1.5; }
    .au-hidebox .au-btns button.pri { background: var(--red, #dc2626); border-color: var(--red, #dc2626); color: #fff; }
    .au-act .it { display: flex; gap: 8px; align-items: center; justify-content: space-between; border: 1px solid var(--border); border-radius: 8px; padding: 6px 10px; font-size: 12.5px; }
  `;
  document.head.appendChild(css);

  // ---- the nav button and the panel ----
  const btn = el("button");
  btn.type = "button";
  btn.dataset.tab = "automation";
  btn.innerHTML = '<svg class="nv-i" viewBox="0 0 24 24" aria-hidden="true"><path d="M13 2L4 14h7l-1 8 9-12h-7z"/></svg><span>Automation</span><span class="au-x" role="button" title="Hide the Automation tab (/automation shows it again) - what is switched on keeps running">\u2715</span>';
  btn.onclick = (e) => {
    if (e.target && e.target.closest && e.target.closest(".au-x")) return; // the ✕ (handled below, before the sidebar)
    if (typeof showOptTab === "function") showOptTab("automation");
    window.scrollTo({ top: 0 });
  };
  // The ✕: caught on the page FIRST (the sidebar's own tab switch used to see the
  // click before the button and open the tab instead of hiding it). Nothing
  // switched on: hidden at once. Something still on (a queue, auto-complete
  // marks, a stop-at time, rules...): listed, to switch off safely before hiding.
  document.addEventListener("click", (e) => {
    const x = e.target && e.target.closest ? e.target.closest('.sidenav button[data-tab="automation"] .au-x') : null;
    if (!x) return;
    e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
    askHide(x);
  }, true);
  async function onNow() {
    const items = (window.PcmConsole && window.PcmConsole.active ? window.PcmConsole.active() : [])
      .filter((i) => i.btn && i.key !== "boxes" && i.key !== "arboxes") // boxes on the rows are not "running"
      .map((i) => ({ text: i.text, tip: i.tip || "" }));
    let rules = [];
    try { const g = await chrome.storage.local.get("autoRules"); rules = (Array.isArray(g.autoRules) ? g.autoRules : []).filter((r) => r && r.on !== false); } catch (e) {}
    return { items, rules };
  }
  let hideBox = null;
  async function askHide(x) {
    if (hideBox) { hideBox.remove(); hideBox = null; }
    const { items, rules } = await onNow();
    const so0 = ((await chrome.storage.local.get("slackOut").catch(() => ({}))).slackOut || {});
    if (so0.on || so0.inOn) items.push({ text: "Check in / out in Slack (posts in #rmt-check-in-check-out)", tip: "" });
    const awayOn = !!(((await chrome.storage.local.get("slackAway").catch(() => ({}))).slackAway || {}).on);
    if (awayOn) items.push({ text: "Away in Slack after work (back to active in the morning)", tip: "" });
    if (!items.length && !rules.length) { await chrome.storage.local.set({ automationTab: false }); return; }
    const box = el("div", "au-hidebox");
    box.appendChild(el("b", "", "Still switched on:"));
    const ul = el("ul");
    for (const i of items) { const li = el("li", "", i.text); li.title = i.tip; ul.appendChild(li); }
    for (const r of rules) ul.appendChild(el("li", "", "Rule: " + (r.name || "a rule")));
    box.appendChild(ul);
    box.appendChild(el("div", "au-st", "Turn them off before hiding, so nothing runs out of sight. (/automation brings the tab back.)"));
    const bb = el("div", "au-btns");
    const off = el("button", "pri", "Turn them off and hide"); off.type = "button";
    const no = el("button", "", "Cancel"); no.type = "button";
    off.onclick = async (e) => {
      e.stopPropagation(); off.disabled = true; off.textContent = "Turning off\u2026";
      try { if (window.PcmConsole && window.PcmConsole.allOff) await window.PcmConsole.allOff(); } catch (x2) {}
      try { const so = (await chrome.storage.local.get("slackOut")).slackOut; if (so && (so.on || so.inOn || so.ahead)) { await chrome.storage.local.set({ slackOut: { ...so, on: false, inOn: false, ahead: false } }); await send({ type: "SLACK_AHEAD_SYNC" }, 60000); } } catch (x2) {}
      try { const sa = (await chrome.storage.local.get("slackAway")).slackAway; if (sa && sa.on) { await chrome.storage.local.set({ slackAway: { ...sa, on: false } }); await send({ type: "SLACK_AWAY_SET", presence: "auto" }); } } catch (x2) {}
      for (const r of rules) { try { await send({ type: "RULES_TOGGLE", id: r.id, on: false }); } catch (x2) {} }
      box.remove(); hideBox = null;
      await chrome.storage.local.set({ automationTab: false });
    };
    no.onclick = (e) => { e.stopPropagation(); box.remove(); hideBox = null; };
    bb.append(off, no);
    box.appendChild(bb);
    document.body.appendChild(box);
    hideBox = box;
    const r0 = x.getBoundingClientRect();
    box.style.left = Math.max(8, Math.min(window.innerWidth - box.offsetWidth - 8, r0.right + 8)) + "px";
    box.style.top = Math.max(8, Math.min(window.innerHeight - box.offsetHeight - 8, r0.top - 10)) + "px";
  }
  document.addEventListener("mousedown", (e) => { if (hideBox && !hideBox.contains(e.target)) { hideBox.remove(); hideBox = null; } }, true);
  const panel = el("section", "panel");
  panel.dataset.panel = "automation";
  let built = false;

  function setShown(on) {
    if (on) {
      if (!btn.isConnected) { const gen = nav.querySelector('[data-tab="general"]'); if (gen) gen.after(btn); else nav.appendChild(btn); }
      if (!panel.isConnected) { const gp = document.querySelector('.panel[data-panel="general"]'); if (gp) gp.after(panel); else document.body.appendChild(panel); }
      if (!built) { built = true; build(); }
      if ((location.hash || "") === "#automation" && typeof showOptTab === "function") showOptTab("automation");
    } else {
      const wasOn = panel.classList.contains("on");
      btn.remove(); panel.remove();
      if (wasOn && typeof showOptTab === "function") showOptTab("dashboard");
    }
  }
  chrome.storage.local.get("automationTab").then((g) => setShown(!!(g && g.automationTab))).catch(() => {});
  chrome.storage.onChanged.addListener((ch, area) => { if (area === "local" && ch.automationTab) setShown(!!ch.automationTab.newValue); });
  window.addEventListener("hashchange", () => { if (location.hash === "#automation" && btn.isConnected && typeof showOptTab === "function") showOptTab("automation"); });

  // ---- the panel's contents ----
  function timeSel(hhmm) {
    const w = el("span", "au-time");
    const t = t12(hhmm);
    const h = el("select"); for (let i = 1; i <= 12; i++) { const o = el("option", "", String(i)); o.value = String(i); h.appendChild(o); } h.value = String(t.h12);
    const m = el("select"); const mins = []; for (let i = 0; i < 60; i++) mins.push(i); if (!mins.includes(t.min)) mins.push(t.min); mins.sort((a, b) => a - b);
    for (const i of mins) { const o = el("option", "", String(i).padStart(2, "0")); o.value = String(i); m.appendChild(o); } m.value = String(t.min);
    const ap = el("select"); for (const v of ["AM", "PM"]) { const o = el("option", "", v); o.value = v; ap.appendChild(o); } ap.value = t.pm ? "PM" : "AM";
    w.append(h, el("span", "", ":"), m, ap);
    w.value = () => from12(h.value, m.value, ap.value === "PM");
    w.onchange = null;
    for (const s of [h, m, ap]) s.addEventListener("change", () => w.dispatchEvent(new Event("au-change")));
    return w;
  }


  function build() {
    panel.innerHTML = "";
    const rules = el("div", "au-card");
    panel.appendChild(rules);
    buildRules(rules);
    const out = el("div", "au-card");
    out.style.marginTop = "20px";
    panel.appendChild(out);
    buildSlackOut(out);
    const away = el("div", "au-card");
    away.style.marginTop = "20px";
    panel.appendChild(away);
    buildSlackAway(away);
    const cheats = el("div", "au-card");
    cheats.style.marginTop = "20px";
    panel.appendChild(cheats);
    buildCheats(cheats);
  }

  // ---------- When (shared): every week on some days, or only on some dates ----------
  // cfg { mode "days"|"dates", days [0-6], dates ["YYYY-MM-DD"], skipHolidays };
  // save() stores it. The date box is the extension's own calendar (calendar.js).
  function scheduleBox(cfg, save, radioName, holidayText) {
    if (!Array.isArray(cfg.days) || !cfg.days.length) cfg.days = [1, 2, 3, 4, 5];
    if (!Array.isArray(cfg.dates)) cfg.dates = [];
    const today = () => { const d = new Date(); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); };
    const box = el("div", "au-box");
    const mrow = el("div", "au-row");
    const mDays = el("label"), mDates = el("label");
    const rDays = el("input"); rDays.type = "radio"; rDays.name = radioName; rDays.checked = cfg.mode !== "dates";
    const rDates = el("input"); rDates.type = "radio"; rDates.name = radioName; rDates.checked = cfg.mode === "dates";
    mDays.append(rDays, document.createTextNode(" Every week on"));
    mDates.append(rDates, document.createTextNode(" Only on these dates"));
    const dayRow = el("span", "au-days");
    const NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    for (const i of [1, 2, 3, 4, 5, 6, 0]) {
      const b = el("button", "au-day" + (cfg.days.includes(i) ? " on" : ""), NAMES[i]); b.type = "button";
      b.onclick = () => { cfg.days = cfg.days.includes(i) ? cfg.days.filter((x) => x !== i) : cfg.days.concat(i); if (!cfg.days.length) cfg.days = [i]; b.classList.toggle("on", cfg.days.includes(i)); save(); };
      dayRow.appendChild(b);
    }
    mrow.append(mDays, dayRow);
    const drow = el("div", "au-row");
    const dpick = el("input"); dpick.type = "date"; dpick.title = "Add a date";
    const dlist = el("span", "au-dates");
    drow.append(mDates, dpick, dlist);
    const hrow = el("div", "au-row");
    const hl = el("label"); const hol = el("input"); hol.type = "checkbox"; hol.checked = cfg.skipHolidays !== false;
    hl.append(hol, document.createTextNode(" " + (holidayText || "Skip company holidays")));
    hrow.appendChild(hl);
    box.append(mrow, drow, hrow);
    const paintDates = () => {
      dlist.textContent = "";
      const ds = cfg.dates.filter((d) => d >= today()).sort();
      if (!ds.length) { dlist.appendChild(el("span", "au-st", "no dates yet - pick one")); return; }
      for (const d of ds) {
        const c = el("span", "au-date", new Date(d + "T12:00:00").toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" }) + " ");
        const x = el("button", "", "\u2715"); x.type = "button"; x.title = "Remove this date";
        x.onclick = () => { cfg.dates = cfg.dates.filter((y) => y !== d); paintDates(); save(); };
        c.appendChild(x); dlist.appendChild(c);
      }
    };
    rDays.onchange = () => { cfg.mode = "days"; save(); };
    rDates.onchange = () => { cfg.mode = "dates"; save(); };
    dpick.onchange = () => { const v = dpick.value; if (/^\d{4}-\d\d-\d\d$/.test(v) && !cfg.dates.includes(v)) { cfg.dates = cfg.dates.filter((d) => d >= today()).concat(v); cfg.mode = "dates"; rDates.checked = true; paintDates(); save(); } dpick.value = ""; };
    hol.onchange = () => { cfg.skipHolidays = hol.checked; save(); };
    paintDates();
    return { box, refresh: () => dayRow.classList.toggle("off", cfg.mode === "dates") };
  }

  // ---------- Away in Slack ----------
  // Away from the away time, active again from the active time, on weekdays -
  // the background does it (only while this tab is on), once each a day.
  async function buildSlackAway(card) {
    card.append(el("h2", "", "Away in Slack after work"), el("p", "sub", "Slack shows you away from the time you pick, and active again in the morning - on the days you tick, or only on the dates you pick (a day not chosen keeps the last one: Friday's away lasts the weekend). Each happens once a day, so changing it yourself in Slack in between is kept. Untick it, or hide this tab, and you're active again at once. It runs only while this tab is on."));
    const g = await chrome.storage.local.get(["slackAway", "slackAwayNow", "slackSession"]).catch(() => ({}));
    const cfg = { on: false, away: "17:00", active: "08:00", mode: "days", days: [1, 2, 3, 4, 5], dates: [], skipHolidays: true, ...(g.slackAway || {}) };
    const row1 = el("div", "au-row");
    const lab = el("label");
    const on = el("input"); on.type = "checkbox"; on.checked = !!cfg.on;
    lab.append(on, document.createTextNode(" Set me away at"));
    const tAway = timeSel(cfg.away);
    const tActive = timeSel(cfg.active);
    row1.append(lab, tAway, el("span", "", "and active again at"), tActive);
    const st = el("div", "au-st");
    card.append(row1, st);
    const whenAway = scheduleBox(cfg, () => { chrome.storage.local.set({ slackAway: { ...cfg } }).catch(() => {}); whenAway.refresh(); }, "au-away-mode", "Not active on company holidays (away still happens)");
    card.appendChild(whenAway.box);
    whenAway.refresh();
    const paint = (now, err) => {
      st.className = "au-st" + (err ? " err" : "");
      if (err) { st.textContent = err; return; }
      if (!g.slackSession) { st.textContent = "Connect Slack first (Clients \u203A Slack channels)."; return; }
      const last = now && now.at ? " Last set: " + (now.presence === "away" ? "away" : "active") + " at " + fmtT(now.at) + (new Date(now.at).toDateString() === new Date().toDateString() ? "" : " on " + new Date(now.at).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })) + "." : "";
      st.textContent = (on.checked ? "On - away at " + fmtT(new Date().setHours(...tAway.value().split(":").map(Number), 0, 0)) + ", active at " + fmtT(new Date().setHours(...tActive.value().split(":").map(Number), 0, 0)) + (cfg.mode === "dates" ? ", on the dates below." : ", on the days ticked below.") : "Off.") + last;
    };
    const save = async (e) => {
      const was = !!cfg.on;
      if (tActive.value() >= tAway.value()) { paint(null, "The active time has to be before the away time (e.g. active 8:00 AM, away 5:00 PM)."); return; }
      Object.assign(cfg, { on: on.checked, away: tAway.value(), active: tActive.value() });
      // A new time takes effect today: forget what was already done today.
      await chrome.storage.local.set({ slackAway: { ...cfg }, ...(e && e.type === "au-change" ? { slackAwayLast: {} } : {}) }).catch(() => {});
      if (was && !cfg.on) { const r = await send({ type: "SLACK_AWAY_SET", presence: "auto" }); if (!r || !r.ok) { paint(null, "Turned off, but couldn't set you active in Slack: " + ((r && r.error) || "no answer")); return; } }
      if (!was && cfg.on) await chrome.storage.local.set({ slackAwayLast: {} }).catch(() => {}); // starts fresh: today's step happens within a minute
      paint((await chrome.storage.local.get("slackAwayNow").catch(() => ({}))).slackAwayNow);
    };
    on.addEventListener("change", save);
    tAway.addEventListener("au-change", save);
    tActive.addEventListener("au-change", save);
    chrome.storage.onChanged.addListener((ch, area) => { if (area === "local" && ch.slackAwayNow) paint(ch.slackAwayNow.newValue); });
    paint(g.slackAwayNow);
  }

  // ---------- Check in / out in Slack ----------
  // "in" in the morning and "out" in the evening in #rmt-check-in-check-out, on
  // the days ticked (or only on dates picked) - the background posts them (only
  // while this tab is on), once a day each, within 2 hours of their time.
  async function buildSlackOut(card) {
    card.append(el("h2", "", "Check in / out in Slack"), el("p", "sub", "Posts your check-in and check-out messages in #rmt-check-in-check-out at the times you pick - on the days you tick, or only on the dates you pick. Each goes once a day, within 2 hours of its time: check-out only on a day you worked (time tracked or at the computer), check-in only when you're at the computer. It runs only while this tab is on."));
    const g = await chrome.storage.local.get(["slackOut", "slackOutSent", "slackInSent", "slackSession"]).catch(() => ({}));
    const cfg = { on: false, time: "17:00", text: "out", inOn: false, inTime: "08:00", inText: "in", ahead: false, mode: "days", days: [1, 2, 3, 4, 5], dates: [], skipHolidays: true, ...(g.slackOut || {}) };
    const today = () => { const d = new Date(); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); };
    // Saved at once; with "Schedule in Slack ahead" on (or just turned off), Slack's
    // scheduled posts follow a moment later (a pause, so clicking through days
    // doesn't call Slack for every click).
    let syncT = 0, aheadWas = !!cfg.ahead;
    const save = async () => {
      await chrome.storage.local.set({ slackOut: { ...cfg } }).catch(() => {});
      paintAll();
      if (cfg.ahead || aheadWas) {
        aheadWas = !!cfg.ahead;
        clearTimeout(syncT);
        syncT = setTimeout(async () => { aheadMsg("Updating Slack\u2019s scheduled posts\u2026"); const r = await send({ type: "SLACK_AHEAD_SYNC" }, 60000); aheadMsg(r && r.ok === false && r.error && r.error !== "busy" ? "Slack: " + r.error : ""); paintAhead(); }, 900);
      }
    };
    // One line per message: tick, time, text, Send now, status.
    const rows = [];
    const line = (kind, label) => {
      const k = kind === "in" ? { on: "inOn", time: "inTime", text: "inText", def: "in", sent: "slackInSent" } : { on: "on", time: "time", text: "text", def: "out", sent: "slackOutSent" };
      const box = el("div", "au-box");
      const r1 = el("div", "au-row");
      const lab = el("label");
      const on = el("input"); on.type = "checkbox"; on.checked = !!cfg[k.on];
      lab.append(on, document.createTextNode(" " + label + " at"));
      const ts = timeSel(cfg[k.time]);
      const tx = el("input"); tx.type = "text"; tx.value = cfg[k.text] || k.def; tx.maxLength = 200; tx.placeholder = k.def; tx.style.flex = "0 1 160px";
      const now = el("button", "", "Send now"); now.type = "button"; now.title = "Post it in #rmt-check-in-check-out right now";
      r1.append(lab, ts, el("span", "", "message"), tx, now);
      const st = el("div", "au-st");
      box.append(r1, st);
      on.addEventListener("change", () => { cfg[k.on] = on.checked; save(); });
      ts.addEventListener("au-change", () => { cfg[k.time] = ts.value(); save(); });
      tx.addEventListener("change", () => { cfg[k.text] = tx.value.trim() || k.def; save(); });
      now.onclick = async () => {
        const t = tx.value.trim() || k.def;
        if (!confirm("Post \"" + t + "\" in #rmt-check-in-check-out now?")) return;
        now.disabled = true; now.textContent = "Posting\u2026";
        const r = await send({ type: "SLACK_OUT_NOW", kind, cfg: { [k.text]: t } });
        now.disabled = false; now.textContent = "Send now";
        if (r && r.ok) g[k.sent] = r; else { st.className = "au-st err"; st.textContent = "Not posted: " + ((r && r.error) || "no answer from the extension"); return; }
        paintAll();
      };
      rows.push({ kind, k, on, ts, st });
      return box;
    };
    card.append(line("in", "Check in"), line("out", "Check out"));
    // When: the days of the week, or only some dates.
    const whenBox = scheduleBox(cfg, save, "au-inout-mode");
    card.appendChild(whenBox.box);
    // ---- Schedule in Slack ahead (off unless ticked) ----
    const ab = el("div", "au-box au-ahead");
    const al = el("label", "au-ahead-tick");
    const aOn = el("input"); aOn.type = "checkbox"; aOn.checked = !!cfg.ahead;
    al.append(aOn, document.createTextNode(" Schedule in Slack ahead, so they're posted even when my laptop is off"));
    // The picture: what happens without it, and with it.
    const flow = el("div", "au-flow");
    const side = (cls, title, steps, note) => {
      const c = el("div", "au-flowcol " + cls);
      c.appendChild(el("b", "", title));
      const f = el("div", "au-steps");
      steps.forEach((s, i) => { if (i) f.appendChild(el("span", "au-arrow", "\u2192")); const st = el("span", "au-step"); st.append(el("span", "ic", s[0]), el("span", "", s[1])); f.appendChild(st); });
      c.append(f, el("div", "au-flownote", note));
      return c;
    };
    const offSide = side("off", "Not ticked (now)", [["\uD83D\uDCBB", "Laptop on, Chrome open"], ["\u23F0", "8:00 / 5:00"], ["\uD83D\uDCAC", "the extension posts it"]],
      "\uD83D\uDCA4 Laptop off or asleep at that time: nothing is posted (it catches up within 2 hours if you turn it on). It only posts on a day you worked / when you're at the computer.");
    const onSide = side("on", "Ticked", [["\uD83D\uDCBB", "While your laptop is on"], ["\uD83D\uDCE4", "the next 7 days go to Slack"], ["\u2601\uFE0F", "Slack posts at 8:00 / 5:00"]],
      "\uD83D\uDCA4 Laptop off: still posted - Slack sends them, like a message you schedule yourself. \u26A0\uFE0F It no longer checks that you worked: on a leave or sick day, cancel that day below (or in Slack).");
    flow.append(offSide, onSide);
    const list = el("div", "au-aheadlist");
    const amsg = el("div", "au-st");
    const aheadMsg = (t) => { amsg.className = "au-st" + (/^Slack:/.test(t) ? " err" : ""); amsg.textContent = t; };
    const help = el("div", "au-st au-aheadhelp");
    help.innerHTML = "<b>Cancel or change them?</b> Yes, from here: \u2715 cancels one day in Slack. Changing the time, message, days or dates above updates every upcoming one in Slack, and unticking this (or a message, or hiding this tab) removes them all. In Slack you can also delete or edit them (Drafts &amp; sent \u203A Scheduled) - a day you delete there isn't scheduled again. Slack keeps the next 7 days; the rest follow while your laptop is on.";
    ab.append(al, flow, list, amsg, help);
    card.appendChild(ab);
    const fmtDayT = (ms) => new Date(ms).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" }) + ", " + fmtT(ms);
    async function paintAhead() {
      flow.classList.toggle("is-on", !!cfg.ahead);
      offSide.classList.toggle("now", !cfg.ahead); onSide.classList.toggle("now", !!cfg.ahead);
      list.textContent = ""; help.hidden = !cfg.ahead;
      if (!cfg.ahead) return;
      const sa = (await chrome.storage.local.get("slackAhead").catch(() => ({}))).slackAhead || {};
      const items = Object.entries(sa).filter(([, x]) => x).sort((a, b) => a[1].postAt - b[1].postAt);
      if (!items.length) { list.appendChild(el("div", "au-st", cfg.on || cfg.inOn ? "Nothing scheduled in Slack yet - it's sent within a minute." : "Tick Check in or Check out above to schedule them.")); return; }
      list.appendChild(el("b", "", "Scheduled in Slack"));
      for (const [key, x] of items) {
        const row = el("div", "au-aheadrow" + (x.cancelled ? " cx" : x.postAt <= Date.now() ? " done" : ""));
        row.append(el("span", "", fmtDayT(x.postAt) + " \u00b7 \"" + x.text + "\""));
        if (x.cancelled) row.appendChild(el("span", "au-st", x.how === "slack" ? "deleted in Slack" : "cancelled"));
        else if (x.postAt <= Date.now()) row.appendChild(el("span", "au-st ok", "posted by Slack"));
        else {
          const c = el("button", "", "\u2715 Cancel"); c.type = "button"; c.title = "Delete this one from Slack's scheduled messages";
          c.onclick = async () => { c.disabled = true; c.textContent = "Cancelling\u2026"; const r = await send({ type: "SLACK_AHEAD_CANCEL", key }); if (!r || !r.ok) { c.disabled = false; c.textContent = "\u2715 Cancel"; aheadMsg("Slack: " + ((r && r.error) || "no answer")); } paintAhead(); };
          row.appendChild(c);
        }
        list.appendChild(row);
      }
    }
    aOn.addEventListener("change", () => { cfg.ahead = aOn.checked; save(); paintAhead(); });
    chrome.storage.onChanged.addListener((ch, area) => { if (area === "local" && ch.slackAhead) paintAhead(); });
    paintAhead();
    function paintAll() {
      whenBox.refresh();
      for (const r of rows) {
        const sent = g[r.k.sent];
        r.st.className = "au-st" + (sent && sent.day === today() ? " ok" : "");
        r.st.textContent = "";
        if (!g.slackSession) { r.st.textContent = "Connect Slack first (Clients \u203A Slack channels)."; continue; }
        if (sent && sent.day === today()) {
          r.st.append("\u2713 Posted \"" + sent.text + "\" in #" + sent.channel + " at " + fmtT(sent.at) + (sent.how === "auto" ? " (by itself)" : "") + " \u00b7 ");
          const a = el("a", "", "Open in Slack"); a.href = sent.link; a.target = "_blank"; a.rel = "noopener"; r.st.appendChild(a);
        } else r.st.textContent = r.on.checked ? "On - " + (cfg.mode === "dates" ? "on the dates below" : "on the days ticked below") + " at " + fmtT(new Date().setHours(...r.ts.value().split(":").map(Number), 0, 0)) + "." : "Off.";
      }
    }
    chrome.storage.onChanged.addListener((ch, area) => {
      if (area !== "local") return;
      if (ch.slackOutSent) g.slackOutSent = ch.slackOutSent.newValue;
      if (ch.slackInSent) g.slackInSent = ch.slackInSent.newValue;
      if (ch.slackOutSent || ch.slackInSent) paintAll();
    });
    paintAll();
  }

  // ---------- Rules: WHEN / IF / THEN, built from blocks ----------
  // The background runs them (RULES_* messages); lib-rules.js has the blocks,
  // the checks and the plain words. Nothing here changes ClickUp by itself.
  const R = globalThis.PcmRules;
  const rcss = el("style");
  rcss.textContent = `
    .ru-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
    .ru-head .au-btns { margin-top: 0; }
    .ru-list { display: flex; flex-direction: column; gap: 10px; margin-top: 12px; }
    .ru-card { border: 1px solid var(--border); border-radius: 12px; padding: 12px 14px; background: var(--card); }
    .ru-card.off { opacity: .72; }
    .ru-top { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
    .ru-top b { font-size: 14.5px; flex: 1 1 200px; min-width: 0; }
    .ru-sw { display: inline-flex; align-items: center; gap: 6px; margin: 0; font-size: 12.5px; font-weight: 600; cursor: pointer; }
    .ru-sw input { width: 34px; height: 18px; appearance: none; -webkit-appearance: none; border-radius: 999px; background: var(--border); position: relative; cursor: pointer; margin: 0; transition: background .15s; }
    .ru-sw input::after { content: ""; position: absolute; top: 2px; left: 2px; width: 14px; height: 14px; border-radius: 50%; background: #fff; transition: left .15s; box-shadow: 0 1px 2px rgba(0,0,0,.25); }
    .ru-sw input:checked { background: var(--green, #16a34a); }
    .ru-sw input:checked::after { left: 18px; }
    .ru-strip { display: grid; grid-template-columns: 54px minmax(0, 1fr); gap: 8px; align-items: baseline; padding: 6px 10px; border-radius: 8px; margin-top: 6px; font-size: 13px; }
    .ru-strip > b { font: 600 11px ui-monospace, SFMono-Regular, Consolas, monospace; letter-spacing: .06em; }
    .ru-when { background: rgba(217,119,6,.12); } .ru-when > b { color: var(--amber, #b45309); }
    .ru-if { background: rgba(100,116,139,.12); } .ru-if > b { color: var(--muted); }
    .ru-then { background: rgba(79,70,229,.10); } .ru-then > b { color: var(--indigo, #4f46e5); }
    .ru-meta { font-size: 12px; color: var(--muted); margin-top: 6px; }
    .ru-meta.bad { color: var(--red, #dc2626); }
    .ru-ed { border: 2px solid var(--indigo, #4f46e5); border-radius: 12px; padding: 14px; margin-top: 12px; background: var(--card); }
    .ru-ed h4 { margin: 14px 0 6px; font-size: 13px; letter-spacing: .05em; text-transform: uppercase; }
    .ru-ed h4.w { color: var(--amber, #b45309); } .ru-ed h4.i { color: var(--muted); } .ru-ed h4.t { color: var(--indigo, #4f46e5); }
    .ru-blk { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 8px 10px; border: 1px solid var(--border); border-radius: 9px; margin-top: 6px; }
    .ru-blk select { max-width: 260px; }
    .ru-blk select, .ru-blk input[type=text], .ru-blk input[type=number], .ru-ed > .au-row input[type=text] { width: auto !important; min-width: 0 !important; padding: 5px 8px; border-radius: 7px; border: 1px solid var(--border); background: var(--field, #fff); color: var(--text); font: inherit; font-size: 13px; }
    .ru-blk input[type=text] { flex: 1 1 180px; }
    .ru-blk input[type=number] { width: 70px !important; }
    .ru-blk .x { margin-left: auto; border: 0; background: none; color: var(--muted); cursor: pointer; font-size: 15px; padding: 2px 6px; }
    .ru-blk .x:hover { color: var(--red, #dc2626); }
    .ru-days { display: inline-flex; gap: 3px; }
    .ru-days label { margin: 0; font-weight: 600; font-size: 11.5px; padding: 3px 7px; border-radius: 6px; border: 1px solid var(--border); cursor: pointer; }
    .ru-days input { display: none; }
    .ru-days label.on { background: var(--indigo, #4f46e5); color: #fff; border-color: var(--indigo, #4f46e5); }
    .ru-say { margin-top: 12px; padding: 9px 12px; border-radius: 9px; background: var(--bg2, rgba(127,127,127,.08)); font-size: 13.5px; }
    .ru-probs { color: var(--red, #dc2626); font-size: 12.5px; margin-top: 6px; }
    .ru-hint { font-size: 12px; color: var(--muted); margin-top: 4px; }
    .ru-tpl { display: grid; grid-template-columns: repeat(auto-fit, minmax(230px, 1fr)); gap: 8px; margin-top: 10px; }
    .ru-tpl button { text-align: left; border: 1px solid var(--border); border-radius: 10px; background: var(--card); padding: 10px 12px; cursor: pointer; font: inherit; color: var(--text); }
    .ru-tpl button:hover { border-color: var(--indigo, #4f46e5); }
    .ru-tpl b { display: block; font-size: 13.5px; } .ru-tpl span { font-size: 12px; color: var(--muted); }
    .ru-ai textarea { width: 100%; min-height: 58px; box-sizing: border-box; padding: 8px 10px; border-radius: 8px; border: 1px solid var(--border); background: var(--field, #fff); color: var(--text); font: inherit; font-size: 13.5px; resize: vertical; }
    .ru-log { display: flex; flex-direction: column; gap: 6px; margin-top: 8px; }
    .ru-li { display: grid; grid-template-columns: 74px minmax(0, 1fr) auto; gap: 10px; align-items: start; font-size: 12.5px; border-top: 1px solid var(--border); padding-top: 6px; }
    .ru-li .tm { color: var(--muted); }
    .ru-li .did { color: var(--muted); }
    .ru-pend { border: 1px solid var(--amber, #d97706); background: rgba(217,119,6,.10); border-radius: 10px; padding: 10px 12px; margin-top: 10px; font-size: 13px; }
    .ru-test { font-size: 12.5px; margin-top: 8px; padding: 8px 10px; border-radius: 8px; background: var(--bg2, rgba(127,127,127,.08)); }
    .ru-test li { margin: 3px 0; }
    @media (max-width: 600px) { .ru-li { grid-template-columns: 1fr; } }
  `;
  document.head.appendChild(rcss);

  // One field of a block, by its type. Returns [element, read()].
  function ruField(f, val, onChange) {
    if (f.type === "select") {
      const s = el("select");
      for (const [k, l] of Object.entries(f.opts)) { const o = el("option", "", l); o.value = k; s.appendChild(o); }
      s.value = val != null ? val : f.def;
      s.onchange = onChange;
      return [s, () => s.value];
    }
    if (f.type === "minutes") {
      const w = el("span", "au-tm");
      const i = el("input"); i.type = "number"; i.min = "1"; i.max = "1440"; i.value = String(val != null ? val : f.def);
      i.oninput = onChange;
      w.append(i, el("span", "", "min"));
      return [w, () => Number(i.value) || f.def];
    }
    if (f.type === "time") {
      const t = timeSel(val || f.def);
      t.addEventListener("au-change", onChange);
      return [t, () => t.value()];
    }
    if (f.type === "days") {
      const w = el("span", "ru-days");
      const on = new Set(Array.isArray(val) ? val : f.def);
      [1, 2, 3, 4, 5, 6, 0].forEach((n) => {
        const l = el("label", on.has(n) ? "on" : "", R.DAY_NAMES[n]);
        l.onclick = (e) => { e.preventDefault(); if (on.has(n)) on.delete(n); else on.add(n); l.classList.toggle("on", on.has(n)); onChange(); };
        w.appendChild(l);
      });
      return [w, () => [...on].sort()];
    }
    const i = el("input"); i.type = "text"; i.value = val != null ? val : f.def; i.placeholder = f.k === "title" || f.k === "message" || f.k === "text" ? "you can use {task}, {client}, {estimate}, {tracked}" : "";
    i.oninput = onChange;
    return [i, () => i.value];
  }
  // A block row: a menu of the kind (WHEN / IF / THEN) and its fields.
  function ruBlock(kind, defs, item, onChange, onRemove) {
    const row = el("div", "ru-blk");
    const sel = el("select");
    const o0 = el("option", "", kind === "when" ? "Choose what starts it…" : "Choose…"); o0.value = ""; sel.appendChild(o0);
    for (const [k, d] of Object.entries(defs)) { const o = el("option", "", d.label); o.value = k; if (d.tip) o.title = d.tip; sel.appendChild(o); }
    sel.value = (item && item.type) || "";
    row.appendChild(sel);
    let readers = {};
    const paint = () => {
      while (row.children.length > 1) row.lastChild.remove();
      readers = {};
      const d = defs[sel.value];
      const params = (item && item.type === sel.value && item.params) || {};
      if (d) for (const f of d.f || []) {
        if (f.show && !f.show({ ...params, ...Object.fromEntries(Object.entries(readers).map(([k, r]) => [k, r()])) })) continue;
        if (f.label) row.appendChild(el("span", "ru-hint", f.label));
        const [node, read] = ruField(f, params[f.k], () => { item = read2(); if (f.k === "what") paint(); onChange(); });
        readers[f.k] = read;
        row.appendChild(node);
      }
      if (onRemove) { const x = el("button", "x", "✕"); x.type = "button"; x.title = "Remove"; x.onclick = onRemove; row.appendChild(x); }
    };
    const read2 = () => ({ type: sel.value, params: Object.fromEntries(Object.entries(readers).map(([k, r]) => [k, r()])) });
    sel.onchange = () => { item = { type: sel.value, params: {} }; paint(); onChange(); };
    paint();
    row.read = () => (sel.value ? read2() : null);
    return row;
  }

  function buildRules(card) {
    const head = el("div", "ru-head");
    const ht = el("div");
    ht.append(el("h2", "", "Rules"), el("p", "sub", "When something happens, the extension does things for you. Pick the blocks: WHEN it starts, IF anything must be true, THEN what to do. Rules only ever change your own tasks; a shared task, or more than " + R.LIMITS.bulk + " tasks at once, waits for your OK."));
    const hb = el("div", "au-btns");
    const bNew = el("button", "primary", "+ New rule"); bNew.type = "button";
    const bTpl = el("button", "", "Start from an example"); bTpl.type = "button";
    const bAi = el("button", "", "✨ Describe it"); bAi.type = "button";
    hb.append(bNew, bTpl, bAi);
    head.append(ht, hb);
    const slot = el("div"); // the editor / examples / AI box open here
    const pend = el("div");
    const list = el("div", "ru-list");
    const histBox = el("details", "au-box");
    histBox.innerHTML = "<summary><b>History</b> - what the rules did, with Undo</summary>";
    const hist = el("div", "ru-log");
    histBox.appendChild(hist);
    card.append(head, slot, pend, list, histBox);

    let data = { rules: [], log: [], pending: [] };
    const fmtWhen = (ts) => { const d = new Date(ts); const today = new Date().toDateString() === d.toDateString(); return (today ? "" : d.toLocaleDateString([], { month: "short", day: "numeric" }) + " ") + d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }); };
    async function load() {
      const r = await send({ type: "RULES_GET" }, 15000);
      if (r && r.ok) data = { ...r, rules: r.rules || [], log: r.log || [], pending: r.pending || [] };
      paint();
    }
    function strips(rule) {
      const w = el("div");
      const s1 = el("div", "ru-strip ru-when"); s1.append(el("b", "", "WHEN"), el("span", "", R.sayTrigger(rule.trigger)));
      w.appendChild(s1);
      if (rule.conds && rule.conds.length) { const s2 = el("div", "ru-strip ru-if"); s2.append(el("b", "", "IF"), el("span", "", rule.conds.map(R.sayCond).join(" · and "))); w.appendChild(s2); }
      const s3 = el("div", "ru-strip ru-then"); s3.append(el("b", "", "THEN"), el("span", "", rule.actions.map(R.sayAction).join(" → "))); w.appendChild(s3);
      return w;
    }
    function paint() {
      // waiting for your OK
      pend.textContent = "";
      for (const p of data.pending || []) {
        const b = el("div", "ru-pend");
        const names = (p.ctxs || []).map((c) => (c.task && c.task.name) || (c.site && c.site.name) || "").filter(Boolean);
        b.append(el("b", "", "“" + p.ruleName + "” is waiting for your OK"), el("div", "", "Because it's " + p.why + ": " + names.slice(0, 5).join(", ") + (names.length > 5 ? " and " + (names.length - 5) + " more" : "") + "."));
        const bb = el("div", "au-btns");
        const yes = el("button", "primary", "Do it"); yes.type = "button";
        const no = el("button", "", "Dismiss"); no.type = "button";
        yes.onclick = async () => { yes.disabled = no.disabled = true; yes.textContent = "Doing it…"; await send({ type: "RULES_PENDING", id: p.id, approve: true }, 120000); load(); };
        no.onclick = async () => { await send({ type: "RULES_PENDING", id: p.id, approve: false }); load(); };
        bb.append(yes, no); b.appendChild(bb); pend.appendChild(b);
      }
      // the rules
      list.textContent = "";
      if (!data.rules.length) list.appendChild(el("div", "au-st", "No rules yet. Press + New rule, start from an example, or describe one in a sentence."));
      for (const rule of data.rules) {
        const c = el("div", "ru-card" + (rule.on === false ? " off" : ""));
        const top = el("div", "ru-top");
        const sw = el("label", "ru-sw"); const cb = el("input"); cb.type = "checkbox"; cb.checked = rule.on !== false;
        sw.append(cb, document.createTextNode(rule.on === false ? "Off" : "On"));
        cb.onchange = async () => {
          const r = await send({ type: "RULES_TOGGLE", id: rule.id, on: cb.checked });
          if (r && r.problems) { cb.checked = false; meta.textContent = r.problems.join(" "); meta.classList.add("bad"); return; }
          if (r && r.extraClash) {
            // An Extra Task made in ClickUp already: its repeat and this rule would make two a week.
            cb.checked = false;
            meta.textContent = "";
            meta.classList.add("bad");
            meta.append("Your Extra Task already comes from ClickUp (" + r.extraClash.name + "). If it repeats there, turn that repeat off first (open it \u203A the repeat icon next to the dates \u203A Remove), or you'll get two a week. ClickUp doesn't let other apps change a repeat, so it has to be done there. ");
            const op = el("a", "", "Open it in ClickUp"); op.href = r.extraClash.url; op.target = "_blank"; op.rel = "noopener";
            const any = el("button", "", "Its repeat is off - switch on"); any.type = "button";
            any.onclick = async () => { const r2 = await send({ type: "RULES_TOGGLE", id: rule.id, on: true, force: true }); if (r2 && r2.ok) load(); };
            meta.append(op, " ", any);
            return;
          }
          load();
        };
        const bTest = el("button", "", "Test"); bTest.type = "button";
        const bEdit = el("button", "", "Edit"); bEdit.type = "button";
        const bDel = el("button", "", "Delete"); bDel.type = "button";
        top.append(el("b", "", rule.name), sw, bTest, bEdit, bDel);
        const last = (data.log || []).find((x) => x.ruleId === rule.id);
        const runs = data.runs && data.runs[rule.id] && data.runs[rule.id].day ? data.runs[rule.id] : null;
        const meta = el("div", "ru-meta");
        meta.textContent = last ? "Last ran " + fmtWhen(last.at) + (last.task ? " on " + last.task.name : "") + ": " + (last.did || []).join(", ") : "Hasn't run yet.";
        const test = el("div");
        c.append(top, strips(rule), meta, test);
        bTest.onclick = async () => { test.innerHTML = '<div class="ru-test">Trying it on what\'s there now…</div>'; paintTest(test, await send({ type: "RULES_TEST", rule }, 30000)); };
        bEdit.onclick = () => openEditor(rule);
        let armed = false;
        bDel.onclick = async () => {
          if (!armed) { armed = true; bDel.textContent = "Delete it?"; setTimeout(() => { armed = false; bDel.textContent = "Delete"; }, 3000); return; }
          await send({ type: "RULES_DELETE", id: rule.id }); load();
        };
        list.appendChild(c);
      }
      // history
      hist.textContent = "";
      const log = data.log || [];
      if (!log.length) hist.appendChild(el("div", "au-st", "Nothing yet - each time a rule runs, it's listed here."));
      for (const e of log.slice(0, 40)) {
        const li = el("div", "ru-li");
        const mid = el("div");
        mid.append(el("b", "", e.ruleName || "Rule"), document.createTextNode(e.task ? " · " + e.task.name : e.site ? " · " + (e.site.name || e.site.url) : ""));
        mid.appendChild(el("div", "did", (e.did || []).join(" → ") + (e.undone ? " (undone)" : "")));
        const act = el("div");
        if (Array.isArray(e.undo) && e.undo.length && !e.undone) {
          const u = el("button", "", "Undo"); u.type = "button";
          u.title = "Put back what this rule changed (status, due date, timer)";
          u.onclick = async () => { u.disabled = true; u.textContent = "Undoing…"; const r = await send({ type: "RULES_UNDO", id: e.id }, 60000); if (!r || !r.ok) { u.textContent = (r && r.error) || "Couldn't undo"; return; } load(); };
          act.appendChild(u);
        }
        li.append(el("span", "tm", fmtWhen(e.at)), mid, act);
        hist.appendChild(li);
      }
      if (log.length) { const clr = el("button", "", "Clear history"); clr.type = "button"; clr.style.marginTop = "8px"; clr.onclick = async () => { await send({ type: "RULES_CLEAR_LOG" }); load(); }; hist.appendChild(clr); }
    }
    function paintTest(box, r) {
      box.textContent = "";
      const t = el("div", "ru-test");
      if (!r || !r.ok) { t.textContent = (r && r.error) || "No answer from the extension."; box.appendChild(t); return; }
      if (r.problems && r.problems.length) { t.appendChild(el("div", "ru-probs", r.problems.join(" "))); }
      if (r.note) t.appendChild(el("div", "", r.note));
      if (r.items && r.items.length) {
        const ul = el("ul");
        for (const it of r.items) ul.appendChild(el("li", "", it.would.length ? it.who + ": would " + it.would.join(", then ") + (it.skip ? " " + it.skip : "") : it.who + ": no - " + it.skip));
        t.append(el("div", "", "If it ran right now (nothing is done in a test):"), ul);
      } else if (!r.note) t.appendChild(el("div", "", "Nothing to try it on right now."));
      box.appendChild(t);
    }

    // ---- the editor ----
    function openEditor(rule0, notes) {
      slot.textContent = "";
      let rule = JSON.parse(JSON.stringify(rule0 || { name: "", on: true, trigger: null, conds: [], actions: [] }));
      const ed = el("div", "ru-ed");
      const nameRow = el("div", "au-row");
      const nm = el("input"); nm.type = "text"; nm.placeholder = "Name it (e.g. Wrap up a review on time)"; nm.value = rule.name || ""; nm.style.flex = "1 1 260px";
      nameRow.append(el("b", "", rule0 && rule0.id ? "Edit rule" : "New rule"), nm);
      ed.appendChild(nameRow);
      if (notes) ed.appendChild(el("div", "ru-hint", notes));
      ed.appendChild(el("h4", "w", "When"));
      const whenBox = el("div"); ed.appendChild(whenBox);
      ed.appendChild(el("h4", "i", "If (optional - all must be true)"));
      const ifBox = el("div"); ed.appendChild(ifBox);
      const addIf = el("button", "", "+ Add a condition"); addIf.type = "button"; addIf.style.marginTop = "6px"; ed.appendChild(addIf);
      ed.appendChild(el("h4", "t", "Then (in this order)"));
      const thenBox = el("div"); ed.appendChild(thenBox);
      const addThen = el("button", "", "+ Add an action"); addThen.type = "button"; addThen.style.marginTop = "6px"; ed.appendChild(addThen);
      const say = el("div", "ru-say"); const probs = el("div", "ru-probs"); const test = el("div");
      const bb = el("div", "au-btns");
      const save = el("button", "primary", "Save rule"); save.type = "button";
      const tryIt = el("button", "", "Test"); tryIt.type = "button";
      const cancel = el("button", "", "Cancel"); cancel.type = "button";
      bb.append(save, tryIt, cancel);
      ed.append(say, probs, test, bb);
      slot.appendChild(ed);
      const read = () => {
        const tr = whenBox.firstChild && whenBox.firstChild.read();
        return { ...rule, name: nm.value.trim(), trigger: tr,
          conds: [...ifBox.children].map((r) => r.read()).filter(Boolean),
          actions: [...thenBox.children].map((r) => r.read()).filter(Boolean) };
      };
      const update = () => {
        const { rule: n } = R.normRule(read());
        say.textContent = R.describe(n);
        const p = R.problems(n);
        probs.textContent = p.join(" ");
      };
      whenBox.appendChild(ruBlock("when", R.TRIGGERS, rule.trigger, update, null));
      const addRow = (box, kind, defs, item) => { const row = ruBlock(kind, defs, item, update, () => { row.remove(); update(); }); box.appendChild(row); };
      for (const c of rule.conds || []) addRow(ifBox, "if", R.CONDS, c);
      for (const a of rule.actions || []) addRow(thenBox, "then", R.ACTIONS, a);
      if (!(rule.actions || []).length) addRow(thenBox, "then", R.ACTIONS, null);
      addIf.onclick = () => { addRow(ifBox, "if", R.CONDS, null); update(); };
      addThen.onclick = () => { addRow(thenBox, "then", R.ACTIONS, null); update(); };
      nm.oninput = update;
      update();
      cancel.onclick = () => { slot.textContent = ""; };
      tryIt.onclick = async () => { test.innerHTML = '<div class="ru-test">Trying it…</div>'; paintTest(test, await send({ type: "RULES_TEST", rule: read() }, 30000)); };
      save.onclick = async () => {
        save.disabled = true;
        const r = await send({ type: "RULES_SAVE", rule: read() }, 15000);
        save.disabled = false;
        if (!r || !r.ok) { probs.textContent = (r && r.error) || "Couldn't save."; return; }
        if (r.problems && r.problems.length) { probs.textContent = "Saved, but switched off until this is fixed: " + r.problems.join(" "); rule = r.rule; load(); return; }
        slot.textContent = "";
        load();
      };
      nm.focus();
    }
    bNew.onclick = () => openEditor(null);

    // ---- examples ----
    bTpl.onclick = () => {
      slot.textContent = "";
      const box = el("div", "au-box");
      box.append(el("b", "", "Examples - pick one, then change anything in it before saving"));
      const g = el("div", "ru-tpl");
      for (const t of R.TEMPLATES) {
        const b = el("button"); b.type = "button";
        b.append(el("b", "", t.name), el("span", "", t.why));
        b.onclick = () => { const { rule } = R.normRule({ ...t, on: true }); delete rule.id; openEditor({ ...rule, id: undefined }); };
        g.appendChild(b);
      }
      const close = el("button", "", "Close"); close.type = "button"; close.style.marginTop = "8px"; close.onclick = () => { slot.textContent = ""; };
      box.append(g, close);
      slot.appendChild(box);
    };

    // ---- describe it: a sentence -> a rule (AI), checked before anything is saved ----
    bAi.onclick = () => {
      slot.textContent = "";
      const box = el("div", "au-box ru-ai");
      const ta = el("textarea"); ta.placeholder = "e.g. When I've tracked my estimate on a Review task, complete it and start the next task due today";
      const st = el("div", "au-st", "The AI fills in the blocks; you check them before saving. Only your sentence is sent - never your tasks.");
      const bb = el("div", "au-btns");
      const go = el("button", "primary", "Build the rule"); go.type = "button";
      const close = el("button", "", "Close"); close.type = "button";
      bb.append(go, close);
      box.append(el("b", "", "Describe the rule in a sentence"), ta, bb, st);
      slot.appendChild(box);
      ta.focus();
      close.onclick = () => { slot.textContent = ""; };
      const run = async () => {
        const text = ta.value.trim();
        if (!text) { st.textContent = "Write what you want first."; return; }
        if (!window.PcmAI) { st.textContent = "The AI helper isn't loaded on this page - reload it."; return; }
        go.disabled = true; st.textContent = "Building the rule…";
        try {
          const ans = await window.PcmAI.generate(R.AI_SYSTEM, R.catalogForAi() + "\n\nThe sentence:\n" + text);
          const res = R.fromAiText(ans);
          if (res.error) { st.textContent = res.error + " Try saying it another way, or build it with + New rule."; go.disabled = false; return; }
          const left = res.dropped.concat(res.unplaced);
          openEditor({ ...res.rule, on: true, id: undefined, name: res.rule.name || text.slice(0, 60) }, "Built from: “" + text + "”. Check every block before saving." + (left.length ? " Couldn't place: " + left.join("; ") + "." : ""));
        } catch (e) {
          go.disabled = false;
          if (e && e.code === "consent") {
            st.innerHTML = "";
            st.append("Chrome's own AI isn't available on this computer. Use the free online AI? Only your sentence is sent. ");
            const ok = el("button", "", "Yes, use it"); ok.type = "button";
            ok.onclick = () => { window.PcmAI.allowOnline(); run(); };
            st.appendChild(ok);
            return;
          }
          st.textContent = "The AI couldn't build it: " + ((e && e.message) || e) + ". Try again, or use + New rule.";
        }
      };
      go.onclick = run;
    };

    load();
    chrome.storage.onChanged.addListener((ch, area) => {
      if (area !== "local" || !(ch.autoRules || ch.autoRuleLog || ch.autoRulePending)) return;
      if (slot.firstChild && slot.querySelector(".ru-ed")) { send({ type: "RULES_GET" }).then((r) => { if (r && r.ok) { data = r; } }); return; } // don't redraw under an open editor
      load();
    });
  }

  // ---------- the console's commands, with buttons ----------
  function buildCheats(card) {
    card.append(el("h2", "", "Commands"), el("p", "sub", "Everything the console (Ctrl+Shift+`) can do, here with buttons. Click a command to put it in the box below, add what it needs and press Enter. Hide this tab again with the button at the bottom (or /automation off)."));
    const act = el("div", "au-box");
    act.appendChild(el("b", "", "Switched on now"));
    const actList = el("div", "au-act");
    act.appendChild(actList);
    // ---- "What do you want to do?" - one example per situation, drawn like the
    // ClickUp setup's multi-day example: a small timeline, the command's row
    // highlighted, what to know, and a button that does it.
    const SCEN = [
      { k: "one", label: "Finish one task by itself when its time is up", cmd: "/autocomplete",
        head: 'Example: <b>"Fix meta titles"</b> - 1h estimate, timer started at <b>9:00</b>',
        cols: ["9:00", "9:30", "10:00", "after 10:00"],
        rows: [["Without it", "tracking", "tracking", "alert: estimate reached", "keeps tracking until you stop it"],
          ["With auto-complete", "tracking", "tracking", "\u2713 stops + completes", "-", true]],
        notes: ["Turn it on: <b>\u23F1 Auto-complete</b> in the Tracking now bar (the task running now), or <b>Tick boxes</b> and tick the tasks, or start dragging a task - two drop boxes appear above the list - and drop it on <b>Complete at estimate</b>.",
          "It works mid-tracking: turn it on any time before the estimate is reached.",
          "The task needs an estimate. A task without one gets a dimmed box."],
        go: [["/autocomplete boxes", "Show tick boxes"]] },
      { k: "run", label: "Run several tasks one after another, hands-free", cmd: "/autorun",
        head: 'Example: <b>A</b> 30m, <b>B</b> 1h, <b>C</b> 15m - started at <b>9:00</b>',
        cols: ["9:00", "9:30", "10:30", "10:45"],
        rows: [["Without it", "A tracking", "A over - you start B", "you start C", "you complete each"],
          ["With auto-run", "\u25B6 A", "\u2713 A \u00b7 \u25B6 B", "\u2713 B \u00b7 \u25B6 C", "\u2713 C \u00b7 done", true]],
        notes: ["Click <b>Numbered boxes</b>, then click the tasks in the order they should run (1, 2, 3...) and press <b>Start</b> in the purple Active bar.",
          "Or drag tasks one by one (drop boxes appear above the list while you drag) onto <b>Run in order</b>, then Start.",
          "Each task starts, completes at its estimate, and the next one starts. You get a notification for each."],
        go: [["/autorun boxes", "Show numbered boxes"]] },
      { k: "edit", label: "Change a queue that is already running (add, remove, reorder)", cmd: "/autorun boxes",
        head: 'Example: task <b>4</b> is running, <b>5</b> and <b>6</b> are waiting',
        cols: ["running", "next", "after that", "last"],
        rows: [["Now", "4", "5", "6", "-"],
          ["Click 5 (take it out)", "4", "6 \u2192 5", "-", "-", true],
          ["Click task X (add it)", "4", "5", "X \u2192 6", "-", true],
          ["Click the old 5 again", "4", "5", "6", "old 5 \u2192 7", true]],
        notes: ["With <b>Numbered boxes</b> on during a run, the waiting tasks show their numbers in their boxes.",
          "Click a numbered box to take that task out (the rest move up). Click an empty box to add a task at the end.",
          "To change the order: take a task out and click it back in - it goes to the end. The running task is never touched."],
        go: [["/autorun boxes", "Show numbered boxes"]] },
      { k: "stop", label: "Stop my timer at a set time (task stays open)", cmd: "/stopat",
        head: 'Example: <b>/stopat 2h</b> on the running task, 1h 30m already tracked today',
        cols: ["now", "+30m", "after"],
        rows: [["Without it", "tracking", "tracking", "until you stop it"],
          ["/stopat 2h", "tracking", "\u25A0 timer stops", "task still open", true],
          ["... every day", "tracking", "\u25A0 stops", "same limit tomorrow", true]],
        notes: ["Type the time in the box on the /stopat row (45m, 1h 20m, 1:15) and press Set.",
          "It counts today's time on that task. Tick <b>every day</b> to keep the limit for the next days too.",
          "Use it to cap a task you don't want to finish yet (a long audit split over days)."],
        go: [["/stopat", "Go to /stopat"]] },
      { k: "done", label: "Stop AND complete the task at a set time", cmd: "/completeat",
        head: 'Example: <b>/completeat 45m</b> on a task with no estimate (or a different one)',
        cols: ["now", "at 45m", "after"],
        rows: [["/stopat 45m", "tracking", "\u25A0 timer stops", "task open"],
          ["/completeat 45m", "tracking", "\u2713 stops + completes", "-", true]],
        notes: ["Like auto-complete, but at a time YOU choose instead of the estimate.",
          "Handy for a task with no estimate, or one you know will take less than its estimate."],
        go: [["/completeat", "Go to /completeat"]] },
      { k: "sos", label: "An emergency task comes in while a queue is running", cmd: "",
        head: 'Example: queue task <b>4</b> is running, an urgent task <b>U</b> comes in',
        cols: ["step 1", "step 2", "step 3", "step 4"],
        rows: [["Do this", "\u25B6 start U (4 stops)", "work on U", "\u25B6 start 4 again", "4 completes \u00b7 5 starts", true],
          ["Don't", "Complete on 4", "-", "-", "5 would start", false]],
        notes: ["The queue only moves on when its current task is <b>completed</b>. Stopping or switching tasks just makes it wait.",
          "Auto-complete only acts on the task that is running, so 4 can't finish while you're away.",
          "While you're away the Active bar shows <b>⏸ Queue 4/6 waiting</b>. Don't press its Stop - that ends the whole queue."],
        go: [] },
      { k: "off", label: "Switch everything off", cmd: "/off",
        head: "Turns off, in one go:",
        cols: ["queue", "run order", "auto-complete", "stop-at", "boxes"],
        rows: [["/off", "stopped", "cleared", "cleared", "cleared", "hidden", true]],
        notes: ["The timer that is running keeps running - only the automations stop.",
          "To turn off just one thing, use its own button in <b>Switched on now</b> above."],
        go: [["/off", "Switch everything off"]] },
    ];
    const guide = el("div", "au-box au-gd");
    guide.appendChild(el("b", "", "What do you want to do?"));
    const gLine = el("div", "set-line");
    const gSel = el("select");
    for (const sc of SCEN) { const o = el("option", "", sc.label); o.value = sc.k; gSel.appendChild(o); }
    gLine.appendChild(gSel);
    const gBody = el("div");
    guide.append(gLine, gBody);
    const doCmd = (cmd) => {
      // The same buttons as the command rows below (they guide you on the dashboard).
      const b = cmds.querySelector('button[title="' + cmd + '"]');
      if (b) { b.click(); return; }
      const row = [...cmds.querySelectorAll(".au-cmd")].find((r) => r.querySelector("code") && r.querySelector("code").textContent === cmd);
      if (row) { row.scrollIntoView({ behavior: "smooth", block: "center" }); const i = row.querySelector("input[type=text]"); if (i) setTimeout(() => i.focus(), 300); return; }
      con.run(cmd).then(paintActive);
    };
    function showGuide(k) {
      const sc = SCEN.find((x) => x.k === k) || SCEN[0];
      gSel.value = sc.k;
      gBody.textContent = "";
      const ex = el("div", "md-ex");
      const h = el("div", "md-ex-h"); h.innerHTML = sc.head; ex.appendChild(h);
      const tb = el("table");
      tb.innerHTML = "<thead><tr><th></th>" + sc.cols.map((c) => "<th>" + c + "</th>").join("") + "</tr></thead><tbody>" +
        sc.rows.map((r) => {
          const on = r[r.length - 1] === true, cells = r.slice(1, on || r[r.length - 1] === false ? -1 : undefined);
          return '<tr class="' + (on ? "on" : "") + '"><th>' + r[0] + "</th>" + cells.map((c) => '<td class="' + (on && c !== "-" ? "v" : "") + '">' + c + "</td>").join("") + "</tr>";
        }).join("") + "</tbody>";
      ex.appendChild(tb);
      const ul = el("ul"); ul.innerHTML = sc.notes.map((n) => "<li>" + n + "</li>").join(""); ex.appendChild(ul);
      if (sc.cmd) { const p = el("p", "how"); p.innerHTML = "Command: <b>" + sc.cmd + "</b> (or type it in the console, Ctrl+Shift+`)"; ex.appendChild(p); }
      if (sc.go.length) {
        const bb = el("div", "au-btns");
        for (const [cmd, label] of sc.go) { const b = el("button", "", label); b.type = "button"; b.onclick = () => doCmd(cmd); bb.appendChild(b); }
        ex.appendChild(bb);
      }
      gBody.appendChild(ex);
    }
    gSel.onchange = () => { showGuide(gSel.value); try { localStorage.setItem("auGuide", gSel.value); } catch (e) {} };
    // A command row's "How?" opens its example up here.
    const HOW = { "/autocomplete": "one", "/autorun": "run", "/stopat": "stop", "/completeat": "done", "/off": "off" };
    const list = el("div", "au-box");
    list.appendChild(el("b", "", "Commands"));
    const cmds = el("div", "au-cmds");
    list.appendChild(cmds);
    const term = el("div", "au-term");
    term.innerHTML = '<div class="xt-out"></div><div class="xt-in"><span>›</span><input spellcheck="false" autocomplete="off" placeholder="type a command, e.g. /stopat 1h 10m" /></div>';
    const hide = el("button", "", "Hide the Automation tab"); hide.type = "button";
    hide.onclick = () => chrome.storage.local.set({ automationTab: false });
    card.append(act, guide, list, term, el("div", "au-btns"));
    card.lastChild.appendChild(hide);
    const C = window.PcmConsole;
    if (!C) { cmds.textContent = "The console isn't loaded on this page."; return; }
    const tIn = term.querySelector("input");
    const con = C.attach(term.querySelector(".xt-out"), tIn, term.querySelector(".xt-in span"));
    // One-click buttons. The ones that put boxes on the task rows take you to
    // the dashboard and say there what to do next; the list-and-number ones
    // answer in the box below. Times are yours: typed in, never a fixed example.
    // One row per feature: the "boxes" way of picking sits on the same row as
    // picking by number. Rows left out still work in the console (/doneat is
    // /completeat, /cheats is this list). [command, button label]
    const EX = {
      "/stopat": [["/stopat list", "list"], ["/stopat clear", "clear"]],
      "/autocomplete": [["/autocomplete boxes", "Tick boxes"], ["/autocomplete boxes off", "Hide boxes"], ["/autocomplete", "By number"], ["/autocomplete list", "list"], ["/autocomplete clear", "clear"]],
      "/autorun": [["/autorun boxes", "Numbered boxes"], ["/autorun boxes off", "Hide boxes"], ["/autorun", "By number"], ["/autorun list", "list"], ["/autorun stop", "stop"]],
    };
    const SKIP = new Set(["/automation", "/exit", "/clear", "/cheats", "/doneat", "/autocomplete boxes", "/autorun boxes"]);
    const ABOUT = {
      "/autocomplete": "tasks that complete themselves when their tracked time reaches the estimate - tick them in the task list, or pick them by number (the running task: ⏱ Auto-complete in Tracking now)",
      "/autorun": "run tasks one after another: each starts, completes at its estimate, then the next starts - click numbered boxes in the task list (or pick by number); while one runs, new picks go at its end",
    };
    const TIMED = { "/stopat": "stop the timer", "/doneat": "stop and complete", "/completeat": "stop and complete" };
    const GUIDE = {
      "/autocomplete boxes": "<b>Tick the tasks</b> that should complete themselves when their tracked time reaches their estimate - each ticked one gets a purple \u23F1 tag. Hide the boxes with <b>Hide</b> in the purple Active bar above the list (ticked tasks stay ticked).",
      "/autorun boxes": "<b>Click the boxes in the order the tasks should run</b> (1, 2, 3...), then press <b>Start</b> in the purple Active bar above the list. Each task starts, completes at its estimate, and the next one starts.",
      "/autocomplete": "Pick the tasks by their numbers in the box below (e.g. 1 3 5), then press Enter on an empty line to save.",
      "/autorun": "Type the task numbers in the order they should run (e.g. 3 1 2) in the box below, then answer y.",
    };
    // On the dashboard, above the task list: what to do now, and the way back here.
    function coach(html) {
      document.querySelectorAll(".au-coach").forEach((x) => x.remove());
      const card = document.getElementById("dashTasksCard");
      if (!card) return;
      const c = el("div", "au-coach");
      const tx = el("span", "sp"); tx.innerHTML = html;
      const back = el("button", "", "\u2190 Back to Automation"); back.type = "button";
      back.onclick = () => { c.remove(); if (typeof showOptTab === "function") showOptTab("automation"); window.scrollTo({ top: 0 }); };
      const ok = el("button", "", "Got it"); ok.type = "button"; ok.onclick = () => c.remove();
      c.append(tx, back, ok);
      card.parentNode.insertBefore(c, card);
      if (typeof showOptTab === "function") showOptTab("dashboard");
      setTimeout(() => c.scrollIntoView({ behavior: "smooth", block: "start" }), 80);
    }
    const lastLine = () => { const o = term.querySelector(".xt-out"); const l = o && o.lastElementChild; return l ? { text: l.textContent, cls: l.className } : null; };
    const paintCmds = () => {
      cmds.textContent = "";
      for (const c of C.commands()) {
        if (SKIP.has(c.name)) continue;
        const row = el("div", "au-cmd");
        const nm = el("code", "", c.name);
        const ab = el("span", "ab", ABOUT[c.name] || c.about);
        const b = el("span", "au-btns");
        b.style.marginTop = "0";
        const msg = el("div", "msg");
        const say = () => { const l = lastLine(); if (l) { msg.textContent = l.text.replace(/^\u203A /, ""); msg.className = "msg " + (l.cls || ""); } };
        if (TIMED[c.name]) {
          // The time you want: typed in (45m, 1h 20m, 1:15), once or every day.
          const w = el("span", "au-tm");
          const tm = el("input"); tm.type = "text"; tm.placeholder = "time, e.g. 45m"; tm.title = "When today's time on the running task reaches this: 45m, 1h 20m, 1:15...";
          const dl = el("input"); dl.type = "checkbox";
          const dlab = el("label"); dlab.append(dl, "every day");
          const go = el("button", "", "Set"); go.type = "button";
          const fire = async () => {
            const v = tm.value.trim();
            if (!v) { msg.textContent = "Type the time first - any time you like (45m, 1h 20m, 1:15)."; msg.className = "msg e"; tm.focus(); return; }
            await con.run(c.name + " " + v + (dl.checked ? " daily" : ""));
            say();
            paintActive();
          };
          go.onclick = fire;
          tm.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); fire(); } });
          w.append(tm, dlab, go);
          b.appendChild(w);
        }
        for (const [ex, label] of EX[c.name] || (TIMED[c.name] ? [] : [[c.name, "Run"]])) {
          const x = el("button", "", label); x.type = "button";
          x.title = ex;
          x.onclick = async () => {
            await con.run(ex);
            say();
            paintActive();
            // Boxes on the task rows: go there and say what to do with them.
            if (GUIDE[ex] && / boxes$/.test(ex)) coach(GUIDE[ex]);
            else if (GUIDE[ex]) { msg.innerHTML = GUIDE[ex]; msg.className = "msg"; tIn.focus(); term.scrollIntoView({ behavior: "smooth", block: "nearest" }); }
          };
          b.appendChild(x);
        }
        if (HOW[c.name]) {
          const hw = el("button", "au-how", "How?"); hw.type = "button"; hw.title = "See an example of what this does";
          hw.onclick = () => { showGuide(HOW[c.name]); guide.scrollIntoView({ behavior: "smooth", block: "start" }); };
          b.appendChild(hw);
        }
        row.append(nm, ab, b, msg);
        cmds.appendChild(row);
      }
    };
    const paintActive = () => {
      actList.textContent = "";
      const items = C.active();
      if (!items.length) { actList.appendChild(el("div", "au-st", "Nothing switched on.")); return; }
      for (const it of items) {
        const r = el("div", "it"); r.title = it.tip || "";
        const b = el("button", "", it.btn); b.type = "button";
        b.onclick = async () => { b.disabled = true; await it.run(); setTimeout(paintActive, 300); };
        r.append(el("span", "", it.text), b);
        actList.appendChild(r);
      }
      if (items.length > 1) { const all = el("button", "", "Turn all off"); all.type = "button"; all.onclick = async () => { await C.allOff(); setTimeout(paintActive, 300); }; actList.appendChild(all); }
    };
    paintCmds();
    paintActive();
    let g0 = "one"; try { g0 = localStorage.getItem("auGuide") || "one"; } catch (e) {}
    showGuide(g0);
    setTimeout(paintCmds, 1500); // admin commands appear once the extension says who you are
    chrome.storage.onChanged.addListener((ch, area) => {
      if (area === "local" && (ch.autoStopTasks || ch.autoCompleteTasks || ch.autoRunQueue || ch.acBoxes || ch.arBoxes || ch.autoRunPick)) setTimeout(paintActive, 200);
    });
    tIn.addEventListener("keydown", (e) => { if (e.key === "Enter") setTimeout(paintActive, 600); });
  }
})();
