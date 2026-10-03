// A day plan applied from Insights > Plan ("Apply to my task list"): the task
// list on the dashboard, popup and side panel shows exactly that day's tasks, in
// the plan's order, with the planned time as their estimate - until "Back to my
// filter" or the day is over. Only what you SEE changes; nothing in ClickUp.
// Stored in chrome.storage.local.cuPlanDay so every page follows at once:
//   { at, day, label, rows: [task rows + planMs], cfg: [{ id, name, url, dayEstimateMs }] }
// Pages call PcmPlanDay.view(state) at the top of resolveCuFilterView and
// PcmPlanDay.onChange(repaint). Loaded before options.js / popup.js.
(() => {
  "use strict";
  let plan = null;
  const subs = [];
  const dayStart = (ts) => { const d = new Date(ts); d.setHours(0, 0, 0, 0); return d.getTime(); };
  const active = () => !!(plan && plan.day && Array.isArray(plan.rows) && dayStart(Date.now()) <= plan.day);
  function changed() {
    document.documentElement.classList.toggle("pcm-plan-on", active());
    for (const fn of subs) { try { fn(); } catch (e) {} }
  }
  function load() {
    try {
      chrome.storage.local.get("cuPlanDay").then((g) => {
        plan = g && g.cuPlanDay ? g.cuPlanDay : null;
        // A plan for a day that has passed is dropped.
        if (plan && !active()) { plan = null; chrome.storage.local.remove("cuPlanDay").catch(() => {}); }
        changed();
      }).catch(() => {});
    } catch (e) {}
  }
  try { chrome.storage.onChanged.addListener((ch, area) => { if (area === "local" && ch.cuPlanDay) { plan = ch.cuPlanDay.newValue || null; changed(); } }); } catch (e) {}
  load();

  // Today's tracked time per task, from the state the page already has.
  function trackedToday(st) {
    const m = new Map();
    for (const list of [st && st.tasks, st && st.trackedTasks, st && st.deadlineTasks, st && st.todayFilter && st.todayFilter.tasks]) {
      for (const t of Array.isArray(list) ? list : []) if (t && t.id != null && Number(t.spentMs) > 0) m.set(String(t.id), Math.max(m.get(String(t.id)) || 0, Number(t.spentMs)));
    }
    return m;
  }
  function view(st) {
    if (!active()) return null;
    const isToday = plan.day === dayStart(Date.now());
    const tr = isToday ? trackedToday(st || {}) : new Map();
    // Flat, in the plan's order (_planIdx is read by the pages' row ordering).
    const tasks = plan.rows.map((r, i) => ({ ...r, _planIdx: i, isSubtask: false, parentId: undefined, estimateMs: Number(r.planMs) || Number(r.estimateMs) || 0, totalEstimateMs: Number(r.estimateMs) || 0, spentMs: tr.get(String(r.id)) || 0, spentToday: isToday }));
    const deadlineTasks = (plan.cfg || []).map((d) => ({ ...d, spentMs: tr.get(String(d.id)) || 0, spentToday: isToday }));
    const estimateMs = tasks.reduce((a, t) => a + t.estimateMs, 0) + deadlineTasks.reduce((a, d) => a + (Number(d.dayEstimateMs) || 0), 0);
    const spentMs = tasks.reduce((a, t) => a + t.spentMs, 0) + deadlineTasks.reduce((a, d) => a + d.spentMs, 0);
    return { estimateMs, spentMs, tasks, deadlineTasks, trackedTasks: [], scope: "plan", label: plan.label || "your plan", plan: true };
  }
  async function apply(p) {
    await chrome.storage.local.set({ cuPlanDay: { ...p, at: Date.now() } });
  }
  async function clear() {
    plan = null;
    await chrome.storage.local.remove("cuPlanDay").catch(() => {});
    changed();
  }
  // The "Showing your plan" bar, inserted after `anchor` (once).
  function paintBanner(anchor, id) {
    let bar = document.getElementById(id);
    if (!active() || !anchor) { if (bar) bar.remove(); return; }
    if (!bar) {
      bar = document.createElement("div");
      bar.id = id;
      bar.className = "cu-chartday pcm-planbar";
      anchor.after(bar);
    }
    bar.textContent = "";
    bar.append("📅 Your plan for " + new Date(plan.day).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" }) + " · " + plan.rows.length + " task" + (plan.rows.length === 1 ? "" : "s") + " (from Insights › Plan)");
    bar.title = "Applied from Insights > Plan: the dashboard, popup and side panel show this day's tasks in the plan's order. Nothing was changed in ClickUp.";
    const back = document.createElement("button");
    back.type = "button";
    back.textContent = "✕ Back to my filter";
    back.onclick = () => clear();
    bar.appendChild(back);
  }
  window.PcmPlanDay = { view, apply, clear, paintBanner, active, current: () => plan, onChange: (fn) => subs.push(fn) };
})();
