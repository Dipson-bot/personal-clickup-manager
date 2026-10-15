// The Automation tab (options page). Hidden until /automation is typed in the
// console (Ctrl+Shift+`), and hidden again with /automation off - storage
// automationTab. It holds:
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
    .au-act .it { display: flex; gap: 8px; align-items: center; justify-content: space-between; border: 1px solid var(--border); border-radius: 8px; padding: 6px 10px; font-size: 12.5px; }
  `;
  document.head.appendChild(css);

  // ---- the nav button and the panel ----
  const btn = el("button");
  btn.type = "button";
  btn.dataset.tab = "automation";
  btn.innerHTML = '<svg class="nv-i" viewBox="0 0 24 24" aria-hidden="true"><path d="M13 2L4 14h7l-1 8 9-12h-7z"/></svg><span>Automation</span><span class="au-x" role="button" title="Hide the Automation tab (/automation shows it again) - what is switched on keeps running">\u2715</span>';
  btn.onclick = (e) => {
    // The ✕: hide the tab right here, without opening it first.
    if (e.target && e.target.closest && e.target.closest(".au-x")) { e.stopPropagation(); chrome.storage.local.set({ automationTab: false }); return; }
    if (typeof showOptTab === "function") showOptTab("automation");
    window.scrollTo({ top: 0 });
  };
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
    const m = el("select"); const mins = []; for (let i = 0; i < 60; i += 5) mins.push(i); if (!mins.includes(t.min)) mins.push(t.min); mins.sort((a, b) => a - b);
    for (const i of mins) { const o = el("option", "", String(i).padStart(2, "0")); o.value = String(i); m.appendChild(o); } m.value = String(t.min);
    const ap = el("select"); for (const v of ["AM", "PM"]) { const o = el("option", "", v); o.value = v; ap.appendChild(o); } ap.value = t.pm ? "PM" : "AM";
    w.append(h, el("span", "", ":"), m, ap);
    w.value = () => from12(h.value, m.value, ap.value === "PM");
    w.onchange = null;
    for (const s of [h, m, ap]) s.addEventListener("change", () => w.dispatchEvent(new Event("au-change")));
    return w;
  }

  const MANIFEST = [
    "display_information:",
    "  name: PCM Daily Update",
    "oauth_config:",
    "  scopes:",
    "    user:",
    "      - chat:write",
    "      - channels:read",
    "      - groups:read",
    "settings:",
    "  org_deploy_enabled: false",
    "  socket_mode_enabled: false",
    "  token_rotation_enabled: false",
  ].join("\n");

  function build() {
    panel.innerHTML = "";
    const cheats = el("div", "au-card");
    panel.appendChild(cheats);
    buildCheats(cheats);
  }

  // ---------- the console's commands, with buttons ----------
  function buildCheats(card) {
    card.append(el("h2", "", "Commands"), el("p", "sub", "Everything the console (Ctrl+Shift+`) can do, here with buttons. Click a command to put it in the box below, add what it needs and press Enter. Hide this tab again with the button at the bottom (or /automation off)."));
    const act = el("div", "au-box");
    act.appendChild(el("b", "", "Switched on now"));
    const actList = el("div", "au-act");
    act.appendChild(actList);
    const list = el("div", "au-box");
    list.appendChild(el("b", "", "Commands"));
    const cmds = el("div", "au-cmds");
    list.appendChild(cmds);
    const term = el("div", "au-term");
    term.innerHTML = '<div class="xt-out"></div><div class="xt-in"><span>›</span><input spellcheck="false" autocomplete="off" placeholder="type a command, e.g. /stopat 1h 10m" /></div>';
    const hide = el("button", "", "Hide the Automation tab"); hide.type = "button";
    hide.onclick = () => chrome.storage.local.set({ automationTab: false });
    card.append(act, list, term, el("div", "au-btns"));
    card.lastChild.appendChild(hide);
    const C = window.PcmConsole;
    if (!C) { cmds.textContent = "The console isn't loaded on this page."; return; }
    const tIn = term.querySelector("input");
    const con = C.attach(term.querySelector(".xt-out"), tIn, term.querySelector(".xt-in span"));
    // One-click buttons. The ones that put boxes on the task rows take you to
    // the dashboard and say there what to do next; the list-and-number ones
    // answer in the box below. Times are yours: typed in, never a fixed example.
    const EX = {
      "/stopat": ["/stopat list", "/stopat clear"],
      "/autocomplete": ["/autocomplete", "/autocomplete list", "/autocomplete clear"],
      "/autocomplete boxes": ["/autocomplete boxes", "/autocomplete boxes off"],
      "/autorun": ["/autorun", "/autorun list", "/autorun stop"],
      "/autorun boxes": ["/autorun boxes", "/autorun boxes off"],
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
        if (c.name === "/automation" || c.name === "/exit" || c.name === "/clear") continue;
        const row = el("div", "au-cmd");
        const nm = el("code", "", c.name);
        const ab = el("span", "ab", c.about);
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
        for (const ex of EX[c.name] || (TIMED[c.name] ? [] : [c.name])) {
          const x = el("button", "", ex.replace(c.name, "").trim() || "Run"); x.type = "button";
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
    setTimeout(paintCmds, 1500); // admin commands appear once the extension says who you are
    chrome.storage.onChanged.addListener((ch, area) => {
      if (area === "local" && (ch.autoStopTasks || ch.autoCompleteTasks || ch.autoRunQueue || ch.acBoxes || ch.arBoxes || ch.autoRunPick)) setTimeout(paintActive, 200);
    });
    tIn.addEventListener("keydown", (e) => { if (e.key === "Enter") setTimeout(paintActive, 600); });
  }
})();
