// The "?" next to a parent task's time. ClickUp adds a task's subtasks into its
// own estimate (and its Track time): a 30m task with 1h + 30m subtasks reads
// "2h / 2h" there. The extension lists the subtasks as rows of their own, so
// the parent counts only its own part here ("30m / 30m") - otherwise the day's
// totals would count the subtasks twice. The "?" shows ClickUp's numbers and the
// reason, so the two never look like they disagree. The figures come from
// lib-clickup.js ownShareOfParents (rollupEstimateMs, subtasksEstimateMs,
// subtasksSpentMs, ownSpentAllMs, subtasksList) on the row's task (row._cuTask).
// Options page, popup and side panel; every list, through one MutationObserver.
(() => {
  "use strict";
  const fmt = (ms) => { const m = Math.round((Number(ms) || 0) / 60000); if (m <= 0) return "0m"; const h = Math.floor(m / 60), r = m % 60; return h ? h + "h" + (r ? " " + r + "m" : "") : r + "m"; };
  const el = (tag, cls, text) => { const x = document.createElement(tag); if (cls) x.className = cls; if (text != null) x.textContent = text; return x; };
  const css = el("style");
  css.textContent = `
    .cu-task .cu-rollq { order: 9; flex: 0 0 auto; display: inline-flex; align-items: center; justify-content: center; width: 15px; height: 15px; border-radius: 50%; border: 1px solid var(--border); background: var(--card); color: var(--muted); font-size: 10px; font-weight: 700; line-height: 1; cursor: pointer; padding: 0; margin-left: 2px; align-self: center; }
    .cu-task .cu-rollq:hover, .cu-task .cu-rollq.on { border-color: var(--indigo, #6366f1); color: var(--indigo, #6366f1); }
    .cu-rollpop { position: fixed; z-index: 2147482000; width: min(340px, calc(100vw - 16px)); background: var(--card, #fff); color: var(--text, #111); border: 1px solid var(--border, #ddd); border-radius: 10px; box-shadow: 0 12px 32px rgba(0,0,0,.22); padding: 12px 14px; font-size: 12.5px; line-height: 1.45; }
    .cu-rollpop h4 { margin: 0 0 6px; font-size: 13px; }
    .cu-rollpop table { width: 100%; border-collapse: collapse; margin: 4px 0 8px; }
    .cu-rollpop td { padding: 3px 0; border-top: 1px solid var(--border, #eee); vertical-align: top; }
    .cu-rollpop td.n { text-align: right; white-space: nowrap; padding-left: 10px; font-variant-numeric: tabular-nums; }
    .cu-rollpop tr.tot td { font-weight: 700; }
    .cu-rollpop tr.sub td:first-child { padding-left: 12px; color: var(--muted, #666); }
    .cu-rollpop p { margin: 6px 0 0; color: var(--muted, #555); }
    .cu-rollpop td a { color: inherit; text-decoration: none; }
    .cu-rollpop td a:hover { color: var(--indigo, #6366f1); text-decoration: underline; }
    .cu-rollpop td a::after { content: " ↗"; font-size: 10px; opacity: .6; }
    .cu-rollpop .x { position: absolute; top: 6px; right: 8px; border: 0; background: none; color: var(--muted); cursor: pointer; font-size: 14px; }
  `;
  document.head.appendChild(css);

  let pop = null, popFor = null;
  const closePop = () => { if (pop) { pop.remove(); pop = null; } if (popFor) { popFor.classList.remove("on"); popFor = null; } };
  document.addEventListener("mousedown", (e) => { if (pop && !pop.contains(e.target) && !(popFor && popFor.contains(e.target))) closePop(); }, true);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && pop) closePop(); });
  window.addEventListener("scroll", closePop, true);

  function open(btn, t) {
    closePop();
    const own = Math.max(0, (Number(t.rollupEstimateMs) || 0) - (Number(t.subtasksEstimateMs) || 0));
    const subs = Array.isArray(t.subtasksList) ? t.subtasksList : [];
    const ownSpent = Number(t.ownSpentAllMs) || 0, subSpent = Number(t.subtasksSpentMs) || 0;
    pop = el("div", "cu-rollpop");
    const x = el("button", "x", "✕"); x.type = "button"; x.title = "Close"; x.onclick = closePop;
    pop.append(x, el("h4", "", "Why this differs from ClickUp"));
    pop.appendChild(el("div", "", "In ClickUp this task shows " + fmt(ownSpent + subSpent) + " tracked / " + fmt(t.rollupEstimateMs) + " estimate, because ClickUp adds its subtasks into its own numbers:"));
    const tb = el("table");
    // Each task opens in ClickUp (a new tab), so it can be checked there.
    const row = (cls, label, spent, est, url) => {
      const r = el("tr", cls);
      const c = el("td");
      if (url) { const a = el("a", "", label); a.href = url; a.target = "_blank"; a.rel = "noopener"; a.title = "Open in ClickUp"; c.appendChild(a); } else c.textContent = label;
      r.append(c, el("td", "n", fmt(spent) + " / " + fmt(est)));
      tb.appendChild(r);
    };
    row("", "This task itself", ownSpent, own, t.selfUrl || t.url);
    for (const s of subs) row("sub", "↳ " + (s.name || "subtask") + (s.done ? " ✓" : ""), s.spentMs, s.estimateMs, s.url || (s.id ? "https://app.clickup.com/t/" + encodeURIComponent(s.id) : ""));
    if (!subs.length) row("sub", "↳ its subtasks", subSpent, t.subtasksEstimateMs);
    row("tot", "ClickUp shows (all together)", ownSpent + subSpent, t.rollupEstimateMs);
    pop.appendChild(tb);
    pop.appendChild(el("div", "", "Here this row shows only its own part: " + fmt(own) + " estimate."));
    pop.appendChild(el("p", "", "Its subtasks are listed as rows of their own, each with its own estimate. Counting them in this row as well would count them twice in your day's totals (the estimate would run " + fmt(t.subtasksEstimateMs) + " ahead of what there is to do). Tracked times are everything ever tracked on each task; the row itself shows today's."));
    document.body.appendChild(pop);
    const r = btn.getBoundingClientRect();
    const w = pop.offsetWidth, h = pop.offsetHeight;
    let left = Math.min(window.innerWidth - w - 8, Math.max(8, r.right - w));
    let top = r.bottom + 6;
    if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 6);
    pop.style.left = left + "px"; pop.style.top = top + "px";
    popFor = btn; btn.classList.add("on");
  }

  function decorate(row) {
    const t = row && row._cuTask;
    const spans = row && row.querySelector(":scope > .estpairs");
    if (!spans) return;
    let q = spans.querySelector(":scope > .cu-rollq");
    if (!t || !t.rollupEstimateMs) { if (q) q.remove(); return; }
    if (!q) {
      q = el("button", "cu-rollq", "?");
      q.type = "button";
      q.title = "ClickUp shows " + fmt(t.rollupEstimateMs) + " for this task because it adds in its subtasks - click to see why only its own part counts here";
      q.addEventListener("mousedown", (e) => e.stopPropagation());
      q.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); if (popFor === q) closePop(); else open(q, row._cuTask); });
      spans.appendChild(q);
    }
  }
  const decorateAll = () => document.querySelectorAll(".cu-task").forEach(decorate);
  let pending = 0;
  // Same frame as the redrawn rows (a 120 ms timer let the bare rows show first).
  let burst = 0;
  new MutationObserver(() => {
    if (pending) return;
    pending = 1;
    const run = () => { pending = 0; decorateAll(); };
    if (burst++ < 3) { queueMicrotask(run); setTimeout(() => { burst = 0; }, 0); } else pending = setTimeout(run, 40);
  }).observe(document.documentElement, { childList: true, subtree: true });
  decorateAll();
  window.PcmRollupHelp = { decorateAll, open };
})();
