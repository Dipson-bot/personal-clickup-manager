// Fold a heading in a task list: click a "Week of ..." heading, a month heading
// or an Explore people section and the rows under it hide until it's clicked
// again; a folded month hides its weeks too. The heading keeps its counts and
// totals, so a long month can be read week by week without scrolling past all
// of it. Remembered per heading (storage cuFoldGroups, shared by the popup, the
// side panel and the dashboard). A heading says what it is with data-gk; the
// rows it covers are the .cu-task rows (and an open task's details) after it, up
// to the next heading or anything else (a section label, the list's end marker).
(() => {
  if (window.PcmFold) return;
  let folded = new Set();
  const HEAD = ".cu-wkgroup[data-gk], .cu-mgroup[data-gk]";
  // Rows a heading covers: tasks, an open task's details, a label inside a client's
  // section (cu-foldable) and the Plan with AI note under a client heading.
  const isRow = (n) => n.classList.contains("cu-task") || n.classList.contains("pcm-panel") || n.classList.contains("cu-foldable") || n.classList.contains("pcm-chnote");
  function applyList(list) {
    let month = false, week = false;
    for (const n of list.children) {
      const gk = n.dataset ? n.dataset.gk : "";
      if (gk && n.classList.contains("cu-mgroup")) {
        month = folded.has(gk); week = false;
        n.classList.toggle("folded", month);
        n.classList.remove("cu-gfold");
        continue;
      }
      if (gk && n.classList.contains("cu-wkgroup")) {
        week = folded.has(gk);
        n.classList.toggle("folded", week);
        n.classList.toggle("cu-gfold", month);
        continue;
      }
      if (n.classList.contains("cu-wend")) { week = false; continue; } // a client's weeks end; its heading still covers what follows
      if (!isRow(n)) { month = false; week = false; n.classList.remove("cu-gfold"); continue; }
      n.classList.toggle("cu-gfold", month || week);
    }
  }
  function applyAll() {
    const lists = new Set();
    document.querySelectorAll(HEAD).forEach((h) => { if (h.parentElement) lists.add(h.parentElement); });
    lists.forEach(applyList);
  }
  let queued = false;
  // Same frame as the redraw (a timer would show the rows for a moment first).
  const later = () => { if (queued) return; queued = true; queueMicrotask(() => { queued = false; applyAll(); }); };
  chrome.storage.local.get("cuFoldGroups").then((g) => {
    folded = new Set(Array.isArray(g && g.cuFoldGroups) ? g.cuFoldGroups : []);
    applyAll();
  }).catch(() => {});
  chrome.storage.onChanged.addListener((ch, area) => {
    if (area !== "local" || !ch.cuFoldGroups) return;
    folded = new Set(Array.isArray(ch.cuFoldGroups.newValue) ? ch.cuFoldGroups.newValue : []);
    applyAll();
  });
  new MutationObserver((muts) => {
    for (const m of muts) for (const n of m.addedNodes) {
      if (n.nodeType === 1 && (n.matches(HEAD) || n.querySelector(HEAD) || (n.classList.contains("cu-task") && n.parentElement && n.parentElement.querySelector(HEAD)))) { later(); return; }
    }
  }).observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener("click", (e) => {
    const h = e.target && e.target.closest ? e.target.closest(HEAD) : null;
    if (!h || e.target.closest("button, a, input, select")) return;
    const gk = h.dataset.gk;
    if (folded.has(gk)) folded.delete(gk); else folded.add(gk);
    applyAll();
    chrome.storage.local.set({ cuFoldGroups: [...folded].slice(-300) }).catch(() => {});
  });
  // ---- Client sections in your own order ----
  // With "Custom order (drag to arrange)" on, a client heading (data-client,
  // draggable) can be dragged above or below another client - say in the order
  // you'll finish them. Kept as client keys (storage cuClientOrder, shared by the
  // dashboard, popup and side panel); clients not placed yet come after, A-Z.
  const ckey = (n) => String(n || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
  let clientOrder = [];
  const orderEvt = () => window.dispatchEvent(new Event("pcm-client-order"));
  chrome.storage.local.get("cuClientOrder").then((g) => { if (g && Array.isArray(g.cuClientOrder) && g.cuClientOrder.length) { clientOrder = g.cuClientOrder; orderEvt(); } }).catch(() => {});
  chrome.storage.onChanged.addListener((ch, area) => { if (area === "local" && ch.cuClientOrder) { clientOrder = Array.isArray(ch.cuClientOrder.newValue) ? ch.cuClientOrder.newValue : []; orderEvt(); } });
  function sortClients(names, own) {
    const az = (a, b) => String(a).replace(/^[^a-z0-9]+/i, "").localeCompare(String(b).replace(/^[^a-z0-9]+/i, ""));
    if (!own) return names.slice().sort(az);
    const rank = new Map(clientOrder.map((k, i) => [k, i]));
    return names.slice().sort((a, b) => {
      const ra = rank.has(ckey(a)) ? rank.get(ckey(a)) : Infinity, rb = rank.has(ckey(b)) ? rank.get(ckey(b)) : Infinity;
      return ra !== rb ? ra - rb : az(a, b);
    });
  }
  const CHEAD = ".cu-mgroup[data-client]";
  let cdrag = null; // { head, list, at: { before: heading | null } }
  const clearMarks = () => document.querySelectorAll(".cdrop-before, .cdrop-end").forEach((x) => x.classList.remove("cdrop-before", "cdrop-end"));
  // The client a spot in the list belongs to: the heading at or above it.
  const headOf = (el, list) => {
    let n = el;
    while (n && n.parentElement !== list) n = n.parentElement;
    for (; n; n = n.previousElementSibling) if (n.matches && n.matches(CHEAD)) return n;
    return null;
  };
  document.addEventListener("dragstart", (e) => {
    const h = e.target && e.target.closest ? e.target.closest(CHEAD + '[draggable="true"]') : null;
    if (!h || e.target.closest(".cu-task")) return;
    cdrag = { head: h, list: h.parentElement, before: undefined };
    h.classList.add("cdragging");
    try { e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", h.dataset.client || ""); } catch (x) {}
  });
  document.addEventListener("dragover", (e) => {
    if (!cdrag) return;
    const h = headOf(e.target, cdrag.list);
    if (!h) return;
    e.preventDefault();
    try { e.dataTransfer.dropEffect = "move"; } catch (x) {}
    // The upper half of a heading: before that client; anywhere lower in its
    // section: after it (before the next client, or at the end).
    const r = h.getBoundingClientRect();
    const heads = [...cdrag.list.children].filter((n) => n.matches && n.matches(CHEAD));
    const before = e.target.closest && e.target.closest(CHEAD) === h && e.clientY < r.top + r.height / 2 ? h : heads[heads.indexOf(h) + 1] || null;
    if (cdrag.before === before) return;
    cdrag.before = before;
    clearMarks();
    if (before) before.classList.add("cdrop-before"); else { const last = cdrag.list.lastElementChild; if (last) last.classList.add("cdrop-end"); }
  });
  document.addEventListener("drop", (e) => {
    if (!cdrag || cdrag.before === undefined) return;
    e.preventDefault();
    const names = [...cdrag.list.children].filter((n) => n.matches && n.matches(CHEAD)).map((n) => n.dataset.client);
    const me = cdrag.head.dataset.client;
    const next = names.filter((n) => n !== me);
    const at = cdrag.before ? next.indexOf(cdrag.before.dataset.client) : next.length;
    next.splice(at < 0 ? next.length : at, 0, me);
    // Clients not on screen keep their place after these.
    const shown = next.map(ckey);
    const keep = clientOrder.filter((k) => !shown.includes(k));
    clientOrder = shown.concat(keep).slice(0, 400);
    chrome.storage.local.set({ cuClientOrder: clientOrder }).catch(() => {});
    orderEvt();
  });
  document.addEventListener("dragend", () => {
    if (!cdrag) return;
    cdrag.head.classList.remove("cdragging");
    cdrag = null;
    clearMarks();
  });
  const css = document.createElement("style");
  css.textContent = `
  .cu-gfold { display: none !important; }
  .cu-wkgroup[data-gk], .cu-mgroup[data-gk] { cursor: pointer; user-select: none; }
  .cu-wkgroup[data-gk]::before, .cu-mgroup[data-gk]::before { content: "\\25BE"; display: inline-block; width: 1.1em; color: var(--muted); transition: transform .12s; }
  .cu-wkgroup[data-gk].folded::before, .cu-mgroup[data-gk].folded::before { transform: rotate(-90deg); }
  .cu-wkgroup.folded, .cu-mgroup.folded { opacity: .85; }
  .cu-gtot-h { color: var(--indigo, #6366f1); }
  .cu-mgroup[data-client][draggable="true"] { cursor: grab; }
  .cu-mgroup[data-client][draggable="true"] > b::after { content: " \\283F"; color: var(--muted); font-weight: 400; opacity: .7; }
  .cu-mgroup.cdragging { opacity: .5; }
  .cdrop-before { box-shadow: 0 -3px 0 var(--indigo, #6366f1) !important; }
  .cdrop-end { box-shadow: 0 3px 0 var(--indigo, #6366f1) !important; }
  /* Dark themes: the headings stand clearly apart from the rows (they blended in). */
  html[data-theme="dark"] .cu-mgroup { background: color-mix(in srgb, var(--indigo, #6366f1) 30%, var(--card, #111827)); border: 1px solid color-mix(in srgb, var(--indigo, #6366f1) 55%, transparent); color: #c3cbe0; }
  html[data-theme="dark"] .cu-mgroup b { color: #fff; }
  html[data-theme="dark"] .cu-wkgroup { background: color-mix(in srgb, var(--indigo, #6366f1) 17%, transparent); border-left-color: color-mix(in srgb, var(--indigo, #6366f1) 80%, #fff); color: #b6bfd3; }
  html[data-theme="dark"] .cu-wkgroup b { color: #eef2ff; }
  html[data-theme="dark"] .cu-wkgroup.now { background: color-mix(in srgb, var(--green, #22c55e) 16%, transparent); border-left-color: var(--green, #22c55e); }
  html[data-theme="dark"] .cu-wkgroup.ex-who.shared { background: color-mix(in srgb, #a855f7 18%, transparent); border-left-color: #a855f7; }`;
  document.head.appendChild(css);
  window.PcmFold = { apply: applyAll, isFolded: (k) => folded.has(k), sortClients };
})();
