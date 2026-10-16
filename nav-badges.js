// A small red count on a sidebar tab when something new happened there that you
// haven't looked at yet - and a click on it takes you to that exact thing,
// highlighted. Counts since you last had that tab open (navSeen, per tab):
//   Site monitor  - sites that went down
//   Insights      - tasks archived in ClickUp, comments that @mention you
//   Agent Router  - accounts that need you (their login failed or stopped)
//   Help & issues - admin replies you haven't opened (hubUnread)
//   Reminders     - reminders that went off while you were away (missedAt)
// A tab you keep open for a couple of seconds counts as seen. On first run every
// tab starts at "seen now", so nobody gets a wall of old numbers.
// Also: the sidebar stays reachable on a short (or zoomed-in) window.
(() => {
  "use strict";
  const nav = document.getElementById("sideNav");
  if (!nav) return; // the options page only
  const css = document.createElement("style");
  css.textContent = `
    .sidenav button .nb-badge { margin-left: auto; flex: none; min-width: 18px; height: 18px; box-sizing: border-box; padding: 0 5px; border-radius: 999px; background: var(--red, #dc2626); color: #fff; font-size: 11px; font-weight: 700; line-height: 18px; text-align: center; box-shadow: 0 0 0 2px var(--card); }
    .sidenav button .nb-badge[hidden] { display: none; }
    .sidenav button .nb-badge + .au-x { margin-left: 6px; }
    /* Sticky already; on a short or zoomed-in window it scrolls inside itself so
       the last items (General, Automation) can always be reached. */
    @media (min-width: 881px) { .sidenav { max-height: calc(100vh - 32px); overflow-y: auto; overscroll-behavior: contain; scrollbar-width: thin; } }
  `;
  document.head.appendChild(css);
  const TABS = ["sites", "insights", "agent", "hub", "reminders"];
  const KEYS = ["navSeen", "siteMonitorConfig", "siteMonitorState", "siteOff", "cuArchived", "cuComments", "cuCommentSeen", "arAttention", "hubUnread", "reminders"];
  let seen = null, counts = {};

  // What's new on each tab: { n, items: [{ key, label }] }.
  async function compute() {
    const g = await chrome.storage.local.get(KEYS).catch(() => ({}));
    seen = g.navSeen && typeof g.navSeen === "object" ? g.navSeen : null;
    if (!seen) { // first run: everything counts from now
      seen = {}; for (const t of TABS) seen[t] = Date.now();
      await chrome.storage.local.set({ navSeen: seen }).catch(() => {});
    }
    const out = {};
    // Site monitor: down now, and it went down after you last looked.
    const st = g.siteMonitorState || {}, off = g.siteOff || {};
    const sites = ((g.siteMonitorConfig && g.siteMonitorConfig.sites) || []).filter((s) => {
      const x = s && st[s.url];
      if (!x || x.up !== false || x.paused || off[s.url]) return false;
      const when = Number(x.lastDownNotified) || Number(x.downSince) || 0; // when it went down
      return when > (seen.sites || 0);
    });
    out.sites = { n: sites.length, items: sites.map((s) => ({ key: s.url, label: (s.name || s.url) + " is down" })) };
    // Insights: archived tasks, and comments that mention you.
    const arch = ((g.cuArchived && g.cuArchived.tasks) || []).filter((t) => (t.noticedAt || 0) > (seen.insights || 0));
    const cs = g.cuComments || {}, cseen = g.cuCommentSeen || {};
    const ment = [];
    for (const [id, c] of Object.entries(cs)) {
      const hit = (c && c.list || []).find((x) => x.mention && x.at > (seen.insights || 0) && x.at > (Number(cseen[id]) || 0));
      if (hit) ment.push({ key: id, label: hit.who + " mentioned you on " + (c.name || "a task"), kind: "mention" });
    }
    out.insights = { n: arch.length + ment.length, items: arch.map((t) => ({ key: t.id, label: "Archived: " + t.name, kind: "archived" })).concat(ment) };
    // Agent Router: accounts that need you (written by the background's badge).
    const ar = g.arAttention || {};
    out.agent = { n: ar.n > 0 && (ar.since || 0) > (seen.agent || 0) ? ar.n : 0, items: ar.n > 0 ? [{ key: "ar", label: ar.n + " account" + (ar.n === 1 ? "" : "s") + " need you" }] : [] };
    // Help & issues: admin replies not opened yet.
    const hu = (Array.isArray(g.hubUnread) ? g.hubUnread : []).filter((x) => x && x.at > (seen.hub || 0) - 1);
    out.hub = { n: hu.length, items: hu.map((x) => ({ key: x.id, label: (x.resolved ? "Resolved: " : "Admin replied: ") + x.title })) };
    // Reminders: went off while you were away.
    const miss = (Array.isArray(g.reminders) ? g.reminders : []).filter((r) => r && Number(r.missedAt) > (seen.reminders || 0));
    out.reminders = { n: miss.length, items: miss.map((r) => ({ key: r.id, label: "Missed: " + String(r.text || "").slice(0, 60) })) };
    return out;
  }
  function paint() {
    for (const tab of TABS) {
      const btn = nav.querySelector('[data-tab="' + tab + '"]');
      if (!btn) continue;
      let b = btn.querySelector(".nb-badge");
      const c = counts[tab] || { n: 0, items: [] };
      if (!c.n) { if (b) b.hidden = true; continue; }
      if (!b) { b = document.createElement("span"); b.className = "nb-badge"; const x = btn.querySelector(".au-x"); if (x) btn.insertBefore(b, x); else btn.appendChild(b); }
      const txt = c.n > 99 ? "99+" : String(c.n);
      if (b.textContent !== txt) b.textContent = txt;
      b.hidden = false;
      b.title = c.items.slice(0, 6).map((i) => i.label).join("\n") + (c.items.length > 6 ? "\n+" + (c.items.length - 6) + " more" : "") + "\nClick to go there";
    }
  }
  let t = 0;
  const refresh = () => { clearTimeout(t); t = setTimeout(async () => { counts = await compute(); paint(); }, 150); };
  chrome.storage.onChanged.addListener((ch, area) => { if (area === "local" && KEYS.some((k) => ch[k])) refresh(); });
  refresh();

  // ---- seen: a tab you keep open for a couple of seconds ----
  const curTab = () => { const b = nav.querySelector("[data-tab].on"); return b ? b.dataset.tab : ""; };
  let seenT = 0;
  function watchSeen() {
    clearTimeout(seenT);
    const tab = curTab();
    if (!TABS.includes(tab)) return;
    seenT = setTimeout(async () => {
      if (curTab() !== tab || document.hidden) return;
      const g = await chrome.storage.local.get("navSeen").catch(() => ({}));
      const s = { ...((g && g.navSeen) || {}), [tab]: Date.now() };
      await chrome.storage.local.set({ navSeen: s }).catch(() => {});
    }, 2500);
  }
  window.addEventListener("hashchange", () => setTimeout(watchSeen, 50));
  document.addEventListener("visibilitychange", () => { if (!document.hidden) watchSeen(); });
  setTimeout(watchSeen, 800);

  // ---- a click on a counted tab: straight to the new thing ----
  const flash = (el, label) => { if (window.PcmSearch && window.PcmSearch.flash) window.PcmSearch.flash(el, label); else if (el) el.scrollIntoView({ block: "center", behavior: "smooth" }); };
  const findText = (root, sel, text) => [...root.querySelectorAll(sel)].find((x) => String(x.textContent || "").toLowerCase().includes(String(text || "").toLowerCase()));
  const FALLBACK = { sites: "#siteMonitorStatus", hub: "#hubPanel", insights: '.panel[data-panel="insights"] details[data-drill]', reminders: '.panel[data-panel="reminders"] .card' };
  function target(tab, c) {
    const panel = document.querySelector('.panel[data-panel="' + tab + '"]');
    if (!panel) return null;
    const first = c.items[0] || {};
    if (tab === "sites") {
      for (const it of c.items) { const r = panel.querySelector('[data-sm-row="' + CSS.escape(it.key) + '"]'); if (r) return [r, it.label]; }
      return null; // (the status list after the wait - see the click below)
    }
    if (tab === "insights") {
      try { if (typeof insSetSub === "function") insSetSub("health"); } catch (e) {}
      const kind = first.kind === "mention" ? "unread" : "archived";
      const det = panel.querySelector('details[data-drill="' + kind + '"]');
      if (!det) return null;
      det.open = true;
      const row = det.querySelector('.trow[data-id="' + CSS.escape(first.key) + '"]');
      return [row || det, first.label];
    }
    if (tab === "agent") {
      const h = findText(panel, "h2", "account");
      return h ? [h.closest(".card") || h, first.label] : null;
    }
    if (tab === "hub") {
      const title = String(first.label || "").replace(/^(Resolved|Admin replied): /, "");
      const r = findText(panel, ".hb-row", title);
      return r ? [r, first.label] : null;
    }
    if (tab === "reminders") {
      const txt = String(first.label || "").replace(/^Missed: /, "");
      const r = findText(panel, ".rm-item", txt);
      return r ? [r, first.label] : null;
    }
    return null;
  }
  nav.addEventListener("click", (e) => {
    const btn = e.target && e.target.closest ? e.target.closest("[data-tab]") : null;
    if (!btn || (e.target.closest && e.target.closest(".au-x"))) return;
    setTimeout(watchSeen, 50); // switching tabs here may not change the address
    const tab = btn.dataset.tab, c = counts[tab];
    if (!c || !c.n) return;
    // The tab opens as usual (options.js); then find the thing once it's drawn.
    let n = 0;
    const tryIt = () => {
      const hit = target(tab, c);
      if (hit && hit[0] && (hit[0].offsetParent || ++n > 10)) { flash(hit[0], hit[1]); return; }
      if (++n <= 10) { setTimeout(tryIt, 200); return; }
      // Not drawn as a row (yet): the section itself, still with what is new.
      const fb = document.querySelector(FALLBACK[tab] || "") || document.querySelector('.panel[data-panel="' + tab + '"] .card');
      if (fb) flash(fb, (c.items[0] && c.items[0].label) || "");
    };
    setTimeout(tryIt, 250);
  });
  window.PcmNavBadges = { compute, refresh };
})();
