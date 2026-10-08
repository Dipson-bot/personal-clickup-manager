// Long lists everywhere: any element with data-long="<key>" shows its first 10
// rows, a "Show all N ▾ / Show less ▴" button under it, and - once it holds more
// than 10 - a search box above it that filters the rows by their text. The pages
// keep redrawing their lists however they like; this re-applies itself whenever
// a marked list's rows change, and remembers per list whether it was opened and
// what was typed. Rows are the element's direct children (or data-long-rows, a
// selector inside it, e.g. "tr.row" for a table). data-long-nosearch: the list
// has its own search already - only the Show all button.
(() => {
  "use strict";
  if (window.PcmLong) return;
  const MAX = 10;
  const state = new Map(); // key -> { open, q }
  const css = document.createElement("style");
  css.textContent = `
  .pl-tools { display: flex; gap: 8px; align-items: center; margin: 4px 0 8px; }
  .pl-q { flex: 1 1 200px; max-width: 360px; min-width: 0; font: inherit; font-size: 12.5px; padding: 6px 10px; border: 1px solid var(--border); border-radius: 8px; background: var(--card); color: var(--text); }
  .pl-n { font-size: 11.5px; color: var(--muted); }
  .pl-more { display: block; width: 100%; margin: 6px 0 2px; padding: 6px; font: inherit; font-size: 12px; font-weight: 600; color: var(--indigo, #6366f1); background: rgba(99,102,241,.06); border: 1px dashed var(--indigo, #6366f1); border-radius: 8px; cursor: pointer; }
  .pl-more:hover { background: rgba(99,102,241,.12); }
  [data-long] > .pl-hide, .pl-hide { display: none !important; }`;
  document.head.appendChild(css);

  function rowsOf(box) {
    const sel = box.getAttribute("data-long-rows");
    return sel ? [...box.querySelectorAll(sel)] : [...box.children];
  }
  function apply(box) {
    const key = box.getAttribute("data-long") || "";
    const st = state.get(key) || { open: false, q: "" };
    state.set(key, st);
    const rows = rowsOf(box);
    const max = Number(box.getAttribute("data-long-max")) || MAX;
    // Tools (search) before the list, the button after it - outside the list, so
    // drawing them never counts as the list changing.
    let tools = box.previousElementSibling && box.previousElementSibling.classList.contains("pl-tools") && box.previousElementSibling.dataset.for === key ? box.previousElementSibling : null;
    let more = box.nextElementSibling && box.nextElementSibling.classList.contains("pl-more") && box.nextElementSibling.dataset.for === key ? box.nextElementSibling : null;
    if (rows.length <= max && !st.q) {
      for (const r of rows) r.classList.remove("pl-hide");
      if (tools) tools.remove();
      if (more) more.remove();
      return;
    }
    if (!tools && box.hasAttribute("data-long-nosearch")) {
      // No search box: just the button.
    } else if (!tools) {
      tools = document.createElement("div");
      tools.className = "pl-tools"; tools.dataset.for = key;
      tools.innerHTML = '<input type="search" class="pl-q" placeholder="Search this list…" aria-label="Search this list" /><span class="pl-n"></span>';
      box.parentNode.insertBefore(tools, box);
      const q = tools.querySelector(".pl-q");
      q.value = st.q;
      q.addEventListener("input", () => { st.q = q.value.trim().toLowerCase(); apply(box); });
      q.addEventListener("click", (e) => e.stopPropagation());
    }
    const hit = (r) => !st.q || (r.textContent || "").toLowerCase().includes(st.q);
    const matching = rows.filter(hit);
    const limit = st.open || st.q ? Infinity : max;
    let shown = 0;
    for (const r of rows) {
      const ok = hit(r) && shown < limit;
      if (ok) shown++;
      r.classList.toggle("pl-hide", !ok);
    }
    if (tools) tools.querySelector(".pl-n").textContent = st.q ? matching.length + " of " + rows.length + " match" : rows.length + " in all";
    const need = !st.q && matching.length > max;
    if (need) {
      if (!more) {
        more = document.createElement("button");
        more.type = "button"; more.className = "pl-more"; more.dataset.for = key;
        more.addEventListener("click", (e) => { e.stopPropagation(); st.open = !st.open; apply(box); if (!st.open) try { box.scrollIntoView({ block: "nearest" }); } catch (x) {} });
        box.parentNode.insertBefore(more, box.nextSibling);
      }
      more.textContent = st.open ? "Show less ▴" : "Show all " + matching.length + " ▾";
    } else if (more) more.remove();
  }
  // Watch for marked lists appearing or redrawing (batched into one pass).
  const dirty = new Set();
  let queued = false;
  const flush = () => { queued = false; for (const b of dirty) if (b.isConnected) try { apply(b); } catch (e) {} dirty.clear(); };
  const mark = (b) => { dirty.add(b); if (!queued) { queued = true; setTimeout(flush, 0); } };
  const scan = (root) => {
    if (!root || root.nodeType !== 1) return;
    if (root.hasAttribute && root.hasAttribute("data-long")) mark(root);
    if (root.querySelectorAll) root.querySelectorAll("[data-long]").forEach(mark);
    const up = root.closest && root.parentElement && root.parentElement.closest("[data-long]");
    if (up) mark(up);
  };
  new MutationObserver((muts) => {
    for (const m of muts) {
      if (m.target && m.target.closest) { const b = m.target.closest("[data-long]"); if (b) mark(b); }
      for (const n of m.addedNodes) scan(n);
    }
  }).observe(document.documentElement, { childList: true, subtree: true });
  document.querySelectorAll("[data-long]").forEach(mark);
  window.PcmLong = { apply, refresh: () => document.querySelectorAll("[data-long]").forEach(mark) };
})();
