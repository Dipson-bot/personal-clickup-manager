// Universal search (Ctrl+K / ⌘K, or the search button) for the options page and
// the popup / side panel. Finds:
//  - settings: every card title, label and setting line of the options page,
//    read from the page itself so the list never goes out of date. Picking one
//    opens that section and highlights the setting.
//  - tasks already loaded (today, this/next week, filters): opens them in ClickUp.
//  - a few actions (wrap-up, floating tracker, bulk edit, updates, diagnostics).
(() => {
  "use strict";
  const isOptions = !!document.querySelector('.panel[data-panel="dashboard"]');
  const TAB_NAMES = { dashboard: "Dashboard", clickup: "ClickUp setup", agent: "Agent Router", sites: "Site monitor", bulk: "Bulk edit", admin: "Admin", general: "General" };
  const optUrl = (q, tab) => chrome.runtime.getURL("options.html") + (q ? "?find=" + encodeURIComponent(q) : "") + "#" + tab;
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const norm = (s) => String(s || "").toLowerCase().replace(/\s+/g, " ").trim();

  // ---------- settings index ----------
  function textOf(el) {
    const c = el.cloneNode(true);
    c.querySelectorAll(".hint, select, option, button, input, textarea, svg").forEach((x) => x.remove());
    return c.textContent.replace(/\s+/g, " ").replace(/[:\-–]\s*$/, "").trim();
  }
  function buildSettings(doc, live) {
    const out = [];
    for (const panel of doc.querySelectorAll(".panel[data-panel]")) {
      const tab = panel.dataset.panel;
      if (tab === "dashboard") continue;
      if (live) {
        const nav = document.querySelector('#sideNav [data-tab="' + tab + '"]');
        if (nav && getComputedStyle(nav).display === "none") continue; // Admin / Agent Router hidden for this user
      } else if (tab === "admin") continue;
      const seen = new Set();
      // The section itself ("Agent Router", "Bulk edit") - ranked above its settings.
      out.push({ type: "setting", section: true, text: TAB_NAMES[tab] || tab, tab, where: "Section", el: null });
      for (const el of panel.querySelectorAll("h2, label, .set-line > span.grow, summary")) {
        const t = textOf(el);
        if (!t || t.length < 3 || t.length > 110 || seen.has(t.toLowerCase())) continue;
        seen.add(t.toLowerCase());
        const card = el.closest(".card");
        const cardTitle = card && card.querySelector("h2") ? textOf(card.querySelector("h2")) : "";
        out.push({ type: "setting", text: t, tab, where: TAB_NAMES[tab] + (cardTitle && cardTitle !== t ? " › " + cardTitle : ""), el: live ? el : null });
      }
    }
    return out;
  }
  let settingsIdx = null;
  async function settings() {
    if (settingsIdx) return settingsIdx;
    if (isOptions) settingsIdx = buildSettings(document, true);
    else {
      try {
        const html = await (await fetch(chrome.runtime.getURL("options.html"))).text();
        settingsIdx = buildSettings(new DOMParser().parseFromString(html, "text/html"), false);
      } catch (e) { settingsIdx = []; }
    }
    return settingsIdx;
  }

  // ---------- tasks index (what's already loaded; no ClickUp request) ----------
  async function taskIdx() {
    let st = null;
    try { st = (await chrome.storage.local.get("clickupState")).clickupState; } catch (e) {}
    const out = [];
    const seen = new Set();
    const add = (arr) => {
      for (const t of Array.isArray(arr) ? arr : []) {
        if (!t || !t.id || seen.has(String(t.id))) continue;
        seen.add(String(t.id));
        out.push({ type: "task", text: t.name || "(task)", client: t.client || "", due: t.dueDateMs || null, url: t.url || "https://app.clickup.com/t/" + encodeURIComponent(t.id) });
      }
    };
    if (st) for (const b of [st, st.todayFilter, st.thisWeek, st.nextWeek]) if (b) { add(b.tasks); add(b.deadlineTasks); add(b.trackedTasks); }
    return out;
  }

  // ---------- actions ----------
  const ACTIONS = [
    { text: "Open the end-of-day wrap-up", keys: "wrap up standup tomorrow move", run: () => chrome.tabs.create({ url: chrome.runtime.getURL("wrapup.html") }) },
    { text: "Float the tracker over all apps", keys: "floating tracker picture pip", run: () => chrome.runtime.sendMessage({ type: "FLOAT_TRACKER_OPEN" }, () => void chrome.runtime.lastError) },
    { text: "Bulk edit tasks (due dates, status, priority, estimate)", keys: "bulk edit change due dates many tasks", run: () => go("bulk") },
    { text: "Check for updates", keys: "update version install", run: () => chrome.tabs.create({ url: chrome.runtime.getURL("update.html") }) },
    { text: "Copy diagnostics for support", keys: "help diagnostics bug problem support", run: () => go("general", "helpCard") },
    { text: "Change keyboard shortcuts", keys: "shortcut keys hotkey", run: () => go("general", "shortcutsCard") },
  ].map((a) => ({ ...a, type: "action" }));
  function go(tab, cardId) {
    if (!isOptions) { chrome.tabs.create({ url: optUrl("", tab) }); window.close(); return; }
    location.hash = "#" + tab;
    if (cardId) setTimeout(() => flash(document.getElementById(cardId)), 80);
  }
  function flash(el) {
    if (!el) return;
    const target = el.closest(".set-line, .checkbox, .card") || el;
    target.scrollIntoView({ block: "center", behavior: "smooth" });
    target.classList.add("pcm-flash");
    setTimeout(() => target.classList.remove("pcm-flash"), 1700);
    const input = target.querySelector("input:not([type=hidden]), select, textarea");
    if (input) setTimeout(() => { try { input.focus({ preventScroll: true }); } catch (e) {} }, 400);
  }

  // ---------- matching ----------
  // Forgiving on purpose: spaces and punctuation don't matter ("agentrouter" =
  // "Agent Router"), small typos are fine ("agnet"), and letters in order match
  // ("agrt"). Exact and early matches still rank first.
  const compact = (s) => norm(s).replace(/[^a-z0-9]+/g, "");
  function typoOk(a, b) {
    // Levenshtein distance within 1 (2 for longer words), with an early exit.
    const max = a.length >= 7 ? 2 : 1;
    if (Math.abs(a.length - b.length) > max) return false;
    let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      const cur = [i];
      let best = i;
      for (let j = 1; j <= b.length; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        if (cur[j] < best) best = cur[j];
      }
      if (best > max) return false;
      prev = cur;
    }
    return prev[b.length] <= max;
  }
  // Letters of q in order inside h, close together (an abbreviation like "blkedt"),
  // not scattered across unrelated words.
  function inOrder(q, h) {
    for (let s = h.indexOf(q[0]); s >= 0; s = h.indexOf(q[0], s + 1)) {
      let i = 1, j = s + 1;
      for (; j < h.length && i < q.length; j++) if (h[j] === q[i]) i++;
      if (i === q.length && j - s <= q.length * 2 + 1) return true;
    }
    return false;
  }
  function score(hay, q) {
    if (!q) return 0;
    const h = norm(hay);
    if (h.startsWith(q)) return 100;
    const i = h.indexOf(q);
    if (i >= 0) return 85 - Math.min(35, i);
    const cq = compact(q), ch = compact(hay);
    if (!cq) return 0;
    const ci = ch.indexOf(cq);
    if (ci >= 0) return 75 - Math.min(30, ci);
    const qw = q.split(/[^a-z0-9]+/).filter(Boolean);
    const hw = h.split(/[^a-z0-9]+/).filter(Boolean);
    if (qw.every((w) => h.includes(w))) return 55;
    // Every typed word close to (or the start of) some word: small typos.
    if (qw.every((w) => hw.some((x) => x.startsWith(w) || (w.length >= 4 && (typoOk(w, x) || typoOk(w, x.slice(0, w.length))))))) return 45;
    // A typo in a run-together query: compare against the joined words too.
    if (cq.length >= 5 && hw.length > 1) {
      for (let a = 0; a < hw.length - 1; a++) if (typoOk(cq, hw[a] + hw[a + 1])) return 42;
    }
    if (cq.length >= 3 && inOrder(cq, ch)) return 25;
    return 0;
  }

  // ---------- UI ----------
  const css = document.createElement("style");
  css.textContent = `
    .pcs-back { position: fixed; inset: 0; z-index: 3000; background: rgba(0,0,0,.35); display: flex; justify-content: center; align-items: flex-start; padding-top: 10vh; }
    .pcs-box { width: min(600px, calc(100vw - 24px)); background: var(--card); color: var(--text); border: 1px solid var(--border); border-radius: 12px; box-shadow: 0 18px 40px rgba(0,0,0,.3); overflow: hidden; }
    .pcs-in { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-bottom: 1px solid var(--border); }
    .pcs-in input { flex: 1; border: 0; outline: 0; background: transparent; color: var(--text); font: inherit; font-size: 15px; padding: 4px 2px; }
    .pcs-in kbd { font: 11px ui-monospace, monospace; color: var(--muted); border: 1px solid var(--border); border-radius: 4px; padding: 1px 5px; }
    .pcs-res { max-height: min(60vh, 440px); overflow: auto; padding: 4px 0 6px; }
    .pcs-grp { padding: 8px 14px 3px; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); }
    .pcs-it { display: flex; align-items: baseline; gap: 10px; padding: 7px 14px; cursor: pointer; font-size: 13.5px; }
    .pcs-it .t { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .pcs-it .w { flex: none; font-size: 11.5px; color: var(--muted); max-width: 45%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .pcs-it.on { background: var(--bg2, rgba(99,102,241,.12)); }
    .pcs-empty { padding: 16px 14px; color: var(--muted); font-size: 13px; }
    .pcs-btn, .sidenav .pcs-btn { display: flex; align-items: center; gap: 8px; width: 100%; font: inherit; font-size: 13px; color: var(--muted); background: var(--bg2, transparent); border: 1px solid var(--border); border-radius: 8px; padding: 7px 10px; cursor: pointer; margin-bottom: 8px; text-align: left; }
    .pcs-btn:hover, .sidenav .pcs-btn:hover { color: var(--text); border-color: var(--indigo, #6366f1); }
    .pcs-btn kbd, .sidenav .pcs-btn kbd { margin-left: auto; font: 11px ui-monospace, monospace; border: 1px solid var(--border); border-radius: 4px; padding: 0 5px; }
    .pcs-icon { font-size: 13px; }
  `;
  document.head.appendChild(css);

  let back = null, input = null, resBox = null, items = [], sel = 0;
  async function open() {
    if (back) { input.focus(); return; }
    back = document.createElement("div");
    back.className = "pcs-back";
    back.innerHTML = '<div class="pcs-box" role="dialog" aria-label="Search"><div class="pcs-in"><span aria-hidden="true">🔍</span>' +
      '<input type="text" placeholder="Search settings, tasks and actions" aria-label="Search" /><kbd>Esc</kbd></div><div class="pcs-res"></div></div>';
    document.body.appendChild(back);
    input = back.querySelector("input");
    resBox = back.querySelector(".pcs-res");
    back.addEventListener("mousedown", (e) => { if (e.target === back) close(); });
    input.addEventListener("input", () => { sel = 0; search(); });
    input.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown") { e.preventDefault(); sel = Math.min(items.length - 1, sel + 1); paintSel(); }
      else if (e.key === "ArrowUp") { e.preventDefault(); sel = Math.max(0, sel - 1); paintSel(); }
      else if (e.key === "Enter") { e.preventDefault(); if (items[sel]) pick(items[sel]); }
      else if (e.key === "Escape") { e.preventDefault(); close(); }
    });
    input.focus();
    search();
  }
  function close() { if (back) { back.remove(); back = null; } }
  async function search() {
    const q = norm(input.value);
    const [sets, tasks] = await Promise.all([settings(), taskIdx()]);
    if (!back) return;
    const rank = (arr, key, max) => arr.map((x) => {
      let s = q ? Math.max(score(key(x), q), x.keys ? score(x.keys, q) - 10 : 0) : 0;
      if (s > 0 && x.section) s += 15; // "Agent Router" the section before its settings
      return { x, s };
    })
      .filter((r) => !q || r.s > 0).sort((a, b) => b.s - a.s).slice(0, max).map((r) => r.x);
    const groups = q
      ? [["Settings", rank(sets, (x) => x.text + " " + x.where, 8)], ["Tasks", rank(tasks, (x) => x.text + " " + x.client, 8)], ["Actions", rank(ACTIONS, (x) => x.text, 4)]]
      : [["Actions", ACTIONS]];
    items = [];
    let html = "";
    for (const [name, list] of groups) {
      if (!list.length) continue;
      html += '<div class="pcs-grp">' + name + "</div>";
      for (const it of list) {
        const idx = items.push(it) - 1;
        const where = it.type === "setting" ? it.where
          : it.type === "task" ? [it.client, it.due ? new Date(it.due).toLocaleDateString([], { month: "short", day: "numeric" }) : ""].filter(Boolean).join(" · ")
          : "";
        html += '<div class="pcs-it" data-i="' + idx + '"><span class="t">' + esc(it.text) + '</span><span class="w">' + esc(where) + "</span></div>";
      }
    }
    resBox.innerHTML = html || '<div class="pcs-empty">Nothing found for “' + esc(input.value) + "”.</div>";
    resBox.querySelectorAll(".pcs-it").forEach((el) => {
      el.onmousemove = () => { sel = Number(el.dataset.i); paintSel(); };
      el.onclick = () => pick(items[Number(el.dataset.i)]);
    });
    paintSel();
  }
  function paintSel() {
    if (!resBox) return;
    resBox.querySelectorAll(".pcs-it").forEach((el) => el.classList.toggle("on", Number(el.dataset.i) === sel));
    const on = resBox.querySelector(".pcs-it.on");
    if (on) on.scrollIntoView({ block: "nearest" });
  }
  function pick(it) {
    close();
    if (it.type === "action") { it.run(); return; }
    if (it.type === "task") { chrome.tabs.create({ url: it.url }).catch(() => {}); return; }
    if (!isOptions) { chrome.tabs.create({ url: optUrl(it.section ? "" : it.text, it.tab) }); window.close(); return; }
    location.hash = "#" + it.tab;
    if (it.section) window.scrollTo({ top: 0 });
    else setTimeout(() => flash(it.el), 80);
  }

  // Opened from the popup with ?find=: highlight that setting once the page is ready.
  if (isOptions) {
    const find = new URLSearchParams(location.search).get("find");
    if (find) setTimeout(async () => {
      const hit = (await settings()).find((s) => s.text === find);
      if (hit) flash(hit.el);
      history.replaceState(null, "", location.pathname + location.hash);
    }, 600);
  }

  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "k") { e.preventDefault(); open(); }
  });

  // Entry points: top of the options sidebar, and an icon in the popup header.
  const mac = /Mac/i.test(navigator.platform);
  if (isOptions) {
    const nav = document.getElementById("sideNav");
    if (nav) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "pcs-btn";
      b.innerHTML = '<span class="pcs-icon" aria-hidden="true">🔍</span><span>Search</span><kbd>' + (mac ? "⌘K" : "Ctrl K") + "</kbd>";
      b.onclick = open;
      nav.prepend(b);
    }
  } else {
    const acts = document.querySelector(".header .header-actions");
    if (acts) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "themeBtn";
      b.title = "Search settings, tasks and actions (" + (mac ? "⌘K" : "Ctrl+K") + ")";
      b.setAttribute("aria-label", "Search");
      b.textContent = "🔍";
      b.onclick = open;
      acts.prepend(b);
    }
  }
  window.PcmSearch = { open };
})();
