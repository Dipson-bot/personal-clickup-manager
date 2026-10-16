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


  function build() {
    panel.innerHTML = "";
    const rules = el("div", "au-card");
    panel.appendChild(rules);
    buildRules(rules);
    const cheats = el("div", "au-card");
    cheats.style.marginTop = "20px";
    panel.appendChild(cheats);
    buildCheats(cheats);
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
