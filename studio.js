// Studio theme, the parts styling alone can't do (dashboard only): the brand and
// page groups in the sidebar, a marker that slides to the open page, folding the
// sidebar into an icon rail, and a top bar with the page title, a big search and
// a health pill that holds the status chips. Everything is added when Studio is
// switched on and put back exactly as it was when it's switched off (Classic is
// never changed). The look itself is theme-studio.css.
(() => {
  const root = document.documentElement;
  const nav = document.getElementById("sideNav");
  const main = document.querySelector("main.panels");
  if (!nav || !main || !document.body.classList.contains("tabbed")) return;
  const GROUPS = [["Work", ["dashboard", "insights", "slack", "files", "reminders", "bulk"]], ["Monitor", ["sites", "agent"]], ["Settings", ["clickup", "general", "admin", "automation"]], ["Help", ["guide", "hub"]]];
  const LABEL = { dashboard: "Dashboard", insights: "Insights", files: "Clients", reminders: "Reminders", bulk: "Bulk edit", sites: "Site monitor", agent: "Agent Router", clickup: "ClickUp setup", general: "General", admin: "Admin", hub: "Help & issues", automation: "Automation", slack: "Slack", guide: "Guide" };
  const mac = /Mac/i.test(navigator.platform);
  let added = [], moved = [], ordered = [], obs = [], offFns = [], on = false;

  const el = (tag, cls, html) => { const x = document.createElement(tag); if (cls) x.className = cls; if (html != null) x.innerHTML = html; return x; };
  const add = (node, where, ref) => { if (where === "prepend") ref.prepend(node); else if (where === "before") ref.before(node); else ref.appendChild(node); added.push(node); return node; };
  const move = (node, into, before) => { if (!node) return; moved.push({ node, parent: node.parentNode, next: node.nextSibling }); into.insertBefore(node, before || null); };
  const order = (node, n) => { if (!node) return; ordered.push(node); node.style.order = String(n); };

  function placeMarker() {
    const ind = nav.querySelector(".st-ind"), b = nav.querySelector("[data-tab].on");
    if (!ind) return;
    if (!b || b.offsetParent === null) { ind.style.opacity = "0"; return; }
    ind.style.opacity = "1";
    ind.style.transform = "translateY(" + b.offsetTop + "px)";
    ind.style.height = b.offsetHeight + "px";
  }
  function paintTitle() {
    const b = nav.querySelector("[data-tab].on"), t = main.querySelector(".st-title");
    if (t) t.textContent = (b && (LABEL[b.dataset.tab] || b.textContent.trim())) || "Dashboard";
  }
  function paintHealth() {
    const pill = main.querySelector(".st-health > button");
    if (!pill) return;
    const chips = [...document.querySelectorAll("#statusStrip .st-chip")];
    const bad = chips.filter((c) => c.classList.contains("st-bad")).length, warn = chips.filter((c) => c.classList.contains("st-warn")).length;
    const dots = chips.slice(0, 6).map((c) => '<i class="' + (c.classList.contains("st-bad") ? "d-bad" : c.classList.contains("st-warn") ? "d-warn" : "") + '"></i>').join("");
    pill.innerHTML = '<span class="st-dots">' + dots + "</span>" + (bad ? bad + " need" + (bad === 1 ? "s" : "") + " attention" : warn ? warn + " to look at" : chips.length ? "All good" : "Status");
    pill.title = chips.map((c) => c.textContent.trim()).filter(Boolean).join("\n");
  }

  function turnOn() {
    if (on) return;
    on = true;
    // ---- sidebar: brand, groups, marker, rail button ----
    const ver = (() => { try { return "v" + chrome.runtime.getManifest().version; } catch (e) { return ""; } })();
    order(add(el("div", "st-brand", '<div class="st-logo">PC</div><div class="st-txt"><span class="st-name">ClickUp Manager</span><span class="st-ver">' + ver + "</span></div>"), "prepend", nav), 0);
    order(nav.querySelector(".pcs-btn"), 1);
    GROUPS.forEach(([name, tabs], gi) => {
      order(add(el("div", "st-grp", name), "append", nav), (gi + 1) * 10);
      tabs.forEach((t, i) => order(nav.querySelector('[data-tab="' + t + '"]'), (gi + 1) * 10 + 1 + i));
    });
    // One button: Collapse when open, Expand when folded - its label always says what
    // it will do. "Open on hover" is a separate, named option in the ◐ menu (Studio).
    const CHEV = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg>';
    const rail = el("button", "st-railbtn", CHEV + "<span>Collapse</span>");
    rail.type = "button";
    let railPref = false;
    try { railPref = localStorage.getItem("pcmStRail") === "1"; } catch (e) {}
    const paintRail = () => {
      const folded = root.classList.contains("st-rail");
      rail.querySelector("span").textContent = folded ? "Expand" : "Collapse";
      rail.title = folded ? "Expand the sidebar" : "Collapse the sidebar to icons";
      rail.setAttribute("aria-expanded", folded ? "false" : "true");
    };
    // Folded only while there is room for a side rail (zoomed in / a narrow window puts
    // the sidebar on top, where the rail would hide every label).
    const applyRail = () => { root.classList.toggle("st-rail", railPref && window.innerWidth > 900); paintRail(); placeMarker(); };
    rail.onclick = () => {
      railPref = !root.classList.contains("st-rail");
      try { localStorage.setItem("pcmStRail", railPref ? "1" : ""); } catch (e) {}
      root.classList.remove("st-hovering");
      rail.blur();
      applyRail();
      setTimeout(placeMarker, 320);
    };
    window.addEventListener("resize", applyRail);
    offFns.push(() => window.removeEventListener("resize", applyRail));
    // Open on hover (◐ menu): a short pause first, so passing over it doesn't open it.
    const hoverOn = () => { try { return localStorage.getItem("pcmStHover") === "1"; } catch (e) { return false; } };
    let hovT = 0;
    const enter = () => { if (!root.classList.contains("st-rail") || !hoverOn()) return; clearTimeout(hovT); hovT = setTimeout(() => { root.classList.add("st-hovering"); setTimeout(placeMarker, 30); setTimeout(placeMarker, 260); }, 180); };
    const leave = () => { clearTimeout(hovT); if (root.classList.contains("st-hovering")) { root.classList.remove("st-hovering"); setTimeout(placeMarker, 30); setTimeout(placeMarker, 260); } };
    nav.addEventListener("mouseenter", enter);
    nav.addEventListener("mouseleave", leave);
    offFns.push(() => { nav.removeEventListener("mouseenter", enter); nav.removeEventListener("mouseleave", leave); clearTimeout(hovT); });
    // A small round chevron on the sidebar edge (not a text row at the bottom).
    rail.classList.add("st-edge");
    add(rail, "append", nav.closest(".shell") || nav);
    order(nav.querySelector(".pcm-wx-chip"), 89); // Task weather's line: just above the foot
    add(el("div", "st-ind"), "append", nav);
    applyRail();
    // ---- top bar: title, search, health pill, the header's tools ----
    const top = el("div", "st-top");
    top.appendChild(el("div", "st-title"));
    const search = el("button", "st-search", '<span aria-hidden="true">🔍</span><span>Search tasks, settings, or ask how to…</span><kbd>' + (mac ? "⌘K" : "Ctrl K") + "</kbd>");
    search.type = "button";
    search.onclick = () => { if (window.PcmSearch && window.PcmSearch.open) window.PcmSearch.open(); };
    top.appendChild(search);
    const health = el("div", "st-health");
    const hb = el("button");
    hb.type = "button";
    hb.onclick = () => health.classList.toggle("open");
    health.appendChild(hb);
    const pop = el("div", "st-pop");
    health.appendChild(pop);
    top.appendChild(health);
    const tools = el("div", "st-tools");
    top.appendChild(tools);
    add(top, "prepend", main);
    // The calendar stays in sight on its own; the rest of the status chips go in the pill.
    const cal = document.getElementById("pcmCalChip");
    if (cal) { const calBox = el("div", "st-cal"); top.insertBefore(calBox, health); added.push(calBox); move(cal, calBox); }
    move(document.querySelector(".wrap > .status-row"), pop);
    move(document.querySelector(".pagehead .hdr-tools"), tools);
    const outside = (e) => { if (!health.contains(e.target)) health.classList.remove("open"); };
    document.addEventListener("click", outside);
    offFns.push(() => document.removeEventListener("click", outside));
    const scrolled = () => top.classList.toggle("st-scrolled", window.scrollY > 4);
    window.addEventListener("scroll", scrolled, { passive: true });
    offFns.push(() => window.removeEventListener("scroll", scrolled));
    window.addEventListener("resize", placeMarker);
    offFns.push(() => window.removeEventListener("resize", placeMarker));
    // ---- keep them current ----
    const tabObs = new MutationObserver(() => { const wx = nav.querySelector(".pcm-wx-chip"); if (wx && !wx.style.order) order(wx, 89); placeMarker(); paintTitle(); });
    tabObs.observe(nav, { subtree: true, attributes: true, attributeFilter: ["class"], childList: true });
    obs.push(tabObs);
    const strip = document.getElementById("statusStrip");
    if (strip) { const so = new MutationObserver(paintHealth); so.observe(strip, { subtree: true, childList: true, attributes: true, characterData: true }); obs.push(so); }
    paintTitle(); paintHealth();
    requestAnimationFrame(placeMarker);
    setTimeout(placeMarker, 400); // fonts / late items
  }

  function turnOff() {
    if (!on) return;
    on = false;
    obs.forEach((o) => o.disconnect());
    offFns.forEach((f) => f());
    for (const m of moved.reverse()) { if (m.parent) m.parent.insertBefore(m.node, m.next && m.next.parentNode === m.parent ? m.next : null); }
    added.forEach((n) => n.remove());
    ordered.forEach((n) => { n.style.order = ""; });
    root.classList.remove("st-rail", "st-hoverx", "st-hovering");
    added = []; moved = []; ordered = []; obs = []; offFns = [];
  }

  const sync = () => (root.dataset.ui === "studio" ? turnOn() : turnOff());
  new MutationObserver(sync).observe(root, { attributes: true, attributeFilter: ["data-ui"] });
  // After the search button and the header icons are in place.
  if (document.readyState === "complete") setTimeout(sync, 0); else window.addEventListener("load", () => setTimeout(sync, 0));
  window.PcmStudio = { refresh: () => { placeMarker(); paintTitle(); paintHealth(); } };
})();
