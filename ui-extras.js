// Extras for the task pages (options dashboard, popup, side panel):
//  - task rows marked in autoCompleteTasks get a purple edge and a small tag
//    (the background completes them when their tracked time reaches the estimate);
//  - a small console (Ctrl+Shift+`) for advanced commands. Admin commands are
//    also checked by the background (DEV_CMD).
// Storage: autoCompleteTasks { [taskId]: { name, at } }; acBoxes (true = a tick
// box on every task row that can be marked).
(() => {
  "use strict";
  const esc = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const fmt = (ms) => { const m = Math.round((Number(ms) || 0) / 60000); if (m <= 0) return "0m"; const h = Math.floor(m / 60), r = m % 60; return h ? h + "h" + (r ? " " + r + "m" : "") : r + "m"; };
  const day = (ms) => (ms ? new Date(ms).toLocaleDateString([], { month: "short", day: "numeric" }) : "no due date");
  const send = (msg, ms) => new Promise((ok) => {
    let done = false;
    const to = setTimeout(() => { done = true; ok(null); }, ms || 30000);
    try { chrome.runtime.sendMessage(msg, (r) => { if (done) return; done = true; clearTimeout(to); void chrome.runtime.lastError; ok(r || null); }); } catch (e) { clearTimeout(to); ok(null); }
  });
  const EXTRA_RE = /\bextra\s*\(?s?\)?\s*tasks?\b/i;

  // ---------- marked rows ----------
  let marked = {}, boxes = false, cfgIds = new Set(), queue = null;
  const load = () => chrome.storage.local.get(["autoCompleteTasks", "acBoxes", "settings", "autoRunQueue"]).then((g) => {
    marked = (g && g.autoCompleteTasks) || {};
    queue = (g && g.autoRunQueue) || null;
    boxes = !!(g && g.acBoxes);
    cfgIds = new Set(((g && g.settings && g.settings.clickupDeadlineTaskUrls) || []).map((u) => (String(u).match(/\/t\/([^/?#]+)/) || [])[1]).filter(Boolean));
    paintRows();
  }).catch(() => {});
  try {
    chrome.storage.onChanged.addListener((ch, area) => {
      if (area !== "local") return;
      if (ch.autoCompleteTasks) marked = ch.autoCompleteTasks.newValue || {};
      if (ch.acBoxes) boxes = !!ch.acBoxes.newValue;
      if (ch.autoRunQueue) queue = ch.autoRunQueue.newValue || null;
      if (ch.autoCompleteTasks || ch.acBoxes || ch.autoRunQueue) paintRows();
      if (ch.settings) load();
    });
  } catch (e) {}
  // A row that can be marked: an open, estimated ClickUp task - not the Extra Task,
  // a configured recurring task, a draft or an expected review.
  const canMark = (t) => !!(t && t.id != null && !t.done && !t.local && !/^rev-/.test(String(t.id)) && t.type !== "cfg" && t.type !== "extra" && !("dayEstimateMs" in t) &&
    Number(t.totalEstimateMs || t.estimateMs) > 0 && !EXTRA_RE.test(t.name || "") && !cfgIds.has(String(t.id)));
  async function toggleMark(t, on) {
    const g = await chrome.storage.local.get("autoCompleteTasks").catch(() => ({}));
    const next = { ...((g && g.autoCompleteTasks) || {}) };
    if (on) next[String(t.id)] = { name: t.name || "", at: Date.now() }; else delete next[String(t.id)];
    marked = next;
    await chrome.storage.local.set({ autoCompleteTasks: next });
    paintRows();
  }
  const css = document.createElement("style");
  css.textContent = `
  .cu-task.ac-on { box-shadow: inset 3px 0 0 #8b5cf6; background: rgba(139,92,246,.07); }
  .xa-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; margin: 6px 0; padding: 6px 10px; border: 1px solid rgba(139,92,246,.35); border-radius: 9px; background: rgba(139,92,246,.07); font-size: 11.5px; }
  .xa-bar .xa-l { font-weight: 700; color: #7c3aed; }
  .xa-bar .xa-i { display: inline-flex; align-items: center; gap: 6px; }
  .xa-bar button { font: inherit; font-size: 11px; font-weight: 600; padding: 1px 8px; border: 1px solid rgba(139,92,246,.5); border-radius: 6px; background: transparent; color: #7c3aed; cursor: pointer; }
  .xa-bar button:hover:not(:disabled) { background: #8b5cf6; color: #fff; }
  .xa-bar .xa-all { margin-left: auto; }
  .ac-box { flex: none; width: 15px; height: 15px; margin: 0 6px 0 0; accent-color: #8b5cf6; cursor: pointer; }
  .ac-q { flex: none; font-size: 10px; font-weight: 700; padding: 1px 7px; border-radius: 999px; background: #8b5cf6; color: #fff; white-space: nowrap; }
  .ac-chip { flex: none; font-size: 10px; font-weight: 700; padding: 1px 7px; border-radius: 999px; background: rgba(139,92,246,.15); color: #7c3aed; white-space: nowrap; }
  .xt-back { position: fixed; inset: auto 0 0 0; z-index: 2147482500; display: flex; justify-content: center; padding: 0 12px 12px; pointer-events: none; }
  .xt { pointer-events: auto; width: min(760px, 100%); height: min(340px, 60vh); background: #0d1117; color: #c9d1d9; border: 1px solid #30363d; border-radius: 10px; box-shadow: 0 18px 44px rgba(0,0,0,.45); display: flex; flex-direction: column; font: 12.5px/1.5 ui-monospace, SFMono-Regular, Consolas, monospace; }
  .xt-out { flex: 1; overflow: auto; padding: 10px 12px 4px; white-space: pre-wrap; word-break: break-word; }
  .xt-out .e { color: #f85149; } .xt-out .ok { color: #3fb950; } .xt-out .mu { color: #8b949e; } .xt-out .hl { color: #d2a8ff; } .xt-out .cmd { color: #e6edf3; }
  .xt-in { display: flex; align-items: center; gap: 6px; padding: 6px 12px 10px; border-top: 1px solid #21262d; }
  .xt-in span { color: #8b949e; white-space: nowrap; }
  .xt-in input { flex: 1; background: transparent; border: 0; outline: 0; color: #e6edf3; font: inherit; }
  `;
  document.head.appendChild(css);
  // ---------- what's switched on, above the task list (with its off buttons) ----------
  async function stopQueue() { await send({ type: "DEV_CMD", cmd: "autorun-stop" }, 8000); queue = null; paintRows(); }
  async function clearMarks() { await chrome.storage.local.set({ autoCompleteTasks: {} }); marked = {}; paintRows(); }
  async function hideBoxes() { await chrome.storage.local.set({ acBoxes: false }); boxes = false; paintRows(); }
  async function allOff() { if (queue) await stopQueue(); await clearMarks(); await hideBoxes(); }
  function activeItems() {
    const out = [];
    const n = Object.keys(marked).length;
    if (queue && Array.isArray(queue.ids) && queue.ids.length) out.push({ key: "queue", text: "▶ Queue " + (queue.total - queue.ids.length + 1) + " of " + queue.total + " running" + (queue.paused ? " (paused)" : ""), btn: "Stop", run: stopQueue, tip: "Tasks run one after another: each completes at its estimate, then the next starts" });
    if (n) out.push({ key: "marks", text: "⏱ " + n + " task" + (n === 1 ? "" : "s") + " complete at " + (n === 1 ? "its" : "their") + " estimate", btn: "Turn off", run: clearMarks, tip: Object.values(marked).map((m) => m.name).filter(Boolean).join("\n") });
    if (boxes) out.push({ key: "boxes", text: "☑ Tick boxes in the task list", btn: "Hide", run: hideBoxes, tip: "Tick a task to have it complete at its estimate" });
    return out;
  }
  function paintBar() {
    const anchor = document.getElementById("ltBox") || document.getElementById("dashTasks") || document.getElementById("cuTaskList");
    let bar = document.getElementById("xaBar");
    const items = activeItems();
    if (!items.length || !anchor || !anchor.parentNode) { if (bar) bar.remove(); return; }
    if (!bar) { bar = document.createElement("div"); bar.id = "xaBar"; bar.className = "xa-bar"; }
    if (bar.nextSibling !== anchor) anchor.parentNode.insertBefore(bar, anchor);
    const sig = JSON.stringify(items.map((i) => i.text + i.tip));
    if (bar._sig === sig) return;
    bar._sig = sig;
    bar.textContent = "";
    const lab = document.createElement("span"); lab.className = "xa-l"; lab.textContent = "Active:"; bar.appendChild(lab);
    for (const it of items) {
      const p = document.createElement("span"); p.className = "xa-i"; p.title = it.tip || "";
      const t = document.createElement("span"); t.textContent = it.text;
      const b = document.createElement("button"); b.type = "button"; b.textContent = it.btn;
      b.onclick = async (e) => { e.preventDefault(); e.stopPropagation(); b.disabled = true; await it.run(); };
      p.append(t, b); bar.appendChild(p);
    }
    if (items.length > 1) { const all = document.createElement("button"); all.type = "button"; all.className = "xa-all"; all.textContent = "Turn all off"; all.onclick = async () => { all.disabled = true; await allOff(); }; bar.appendChild(all); }
  }
  function paintRows() {
    paintBar();
    document.querySelectorAll(".cu-task").forEach((row) => {
      const t = row._cuTask;
      const on = !!(t && t.id != null && marked[String(t.id)]);
      row.classList.toggle("ac-on", on);
      const wrap = row.querySelector(".nmwrap");
      let chip = wrap && wrap.querySelector(".ac-chip");
      if (on && wrap && !chip) {
        chip = document.createElement("span");
        chip.className = "ac-chip";
        chip.textContent = "⏱ auto-complete";
        chip.title = "Completes itself (and stops the timer) when its tracked time reaches its estimate";
        const nm = wrap.querySelector(".nm");
        if (nm && nm.nextSibling) wrap.insertBefore(chip, nm.nextSibling); else wrap.appendChild(chip);
      } else if (!on && chip) chip.remove();
      // Its place in the auto-run queue.
      let qc = wrap && wrap.querySelector(".ac-q");
      const qi = queue && Array.isArray(queue.ids) && t ? queue.ids.indexOf(String(t.id)) : -1;
      if (qi >= 0 && wrap) {
        const k = queue.total - queue.ids.length + qi + 1;
        const txt = (qi === 0 ? "▶ running " : "▶ queue ") + k + "/" + queue.total;
        if (!qc) { qc = document.createElement("span"); qc.className = "ac-q"; const nm = wrap.querySelector(".nm"); if (nm && nm.nextSibling) wrap.insertBefore(qc, nm.nextSibling); else wrap.appendChild(qc); }
        qc.textContent = txt;
        qc.title = qi === 0 ? "Running now in the auto-run queue - completes at its estimate, then the next one starts" : "Waiting in the auto-run queue - starts when the one before it completes";
      } else if (qc) qc.remove();
      // The tick box (shown while acBoxes is on).
      let cb = wrap && wrap.querySelector(".ac-box");
      const want = boxes && wrap && canMark(t);
      if (want && !cb) {
        cb = document.createElement("input");
        cb.type = "checkbox";
        cb.className = "ac-box";
        cb.addEventListener("click", (e) => { e.stopPropagation(); toggleMark(row._cuTask, cb.checked); });
        wrap.insertBefore(cb, wrap.firstChild);
      } else if (!want && cb) { cb.remove(); cb = null; }
      if (cb) { cb.checked = on; cb.title = on ? "Marked: completes itself (and stops the timer) when its tracked time reaches its estimate - untick to stop" : "Tick to complete this task automatically when its tracked time reaches its estimate"; }
    });
  }
  let pend = 0;
  new MutationObserver(() => { if (!pend) pend = setTimeout(() => { pend = 0; paintRows(); }, 40); }).observe(document.documentElement, { childList: true, subtree: true });
  load();

  // ---------- console ----------
  let box = null, out = null, inp = null, promptEl = null, mode = null, hist = [], hi = -1, admin = false;
  const line = (text, cls) => { const d = document.createElement("div"); if (cls) d.className = cls; d.textContent = text; out.appendChild(d); out.scrollTop = out.scrollHeight; return d; };
  function openConsole() {
    if (box) { inp.focus(); return; }
    box = document.createElement("div");
    box.className = "xt-back";
    box.innerHTML = '<div class="xt"><div class="xt-out"></div><div class="xt-in"><span>›</span><input spellcheck="false" autocomplete="off" /></div></div>';
    document.body.appendChild(box);
    out = box.querySelector(".xt-out"); inp = box.querySelector("input"); promptEl = box.querySelector(".xt-in span");
    inp.addEventListener("keydown", onKey);
    inp.focus();
    send({ type: "DEV_CMD", cmd: "whoami" }, 8000).then((r) => { admin = !!(r && r.admin); });
  }
  function closeConsole() { if (box) { box.remove(); box = null; mode = null; } }
  function setMode(m) { mode = m; promptEl.textContent = m ? m.name + " ›" : "›"; }
  async function onKey(e) {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); if (mode) { setMode(null); line("cancelled", "mu"); } else closeConsole(); return; }
    if (e.key === "ArrowUp" && hist.length) { e.preventDefault(); hi = Math.min(hist.length - 1, hi + 1); inp.value = hist[hist.length - 1 - hi]; return; }
    if (e.key === "ArrowDown" && hist.length) { e.preventDefault(); hi = Math.max(-1, hi - 1); inp.value = hi < 0 ? "" : hist[hist.length - 1 - hi]; return; }
    if (e.key !== "Enter") return;
    e.preventDefault();
    const v = inp.value.trim();
    inp.value = ""; hi = -1;
    if (mode) { await mode.input(v); return; }
    if (!v) return;
    hist.push(v);
    line("› " + v, "cmd");
    await run(v);
  }

  const COMMANDS = [
    { name: "/cheats", about: "list the commands you can use" },
    { name: "/autocomplete", about: "choose tasks that complete themselves when their tracked time reaches the estimate  (/autocomplete list | clear | off <n>)" },
    { name: "/autocomplete boxes", about: "a tick box on every task row to mark them right in the table  (/autocomplete boxes off to hide)" },
    { name: "/autorun", about: "run tasks one after another: each starts, completes at its estimate, then the next starts  (/autorun list | stop)" },
    { name: "/refresh", about: "read everything from ClickUp again now" },
    { name: "/whoami", about: "who and where you are" },
    { name: "/active", about: "what's switched on, and how to switch each off" },
    { name: "/off", about: "switch everything off (queue, auto-complete marks, tick boxes)" },
    { name: "/clear", about: "clear this box" },
    { name: "/exit", about: "close (or Esc)" },
    { name: "/policy", about: "the live update policy", admin: true },
    { name: "/autoupdate", about: "run the automatic update now, step by step", admin: true },
    { name: "/cacheclear", about: "clear every saved copy and refresh", admin: true },
  ];
  async function run(v) {
    const [cmd, ...rest] = v.split(/\s+/);
    const arg = rest.join(" ").toLowerCase();
    const c = cmd.toLowerCase();
    const def = COMMANDS.find((x) => x.name === c || x.name.split(" ")[0] === c);
    if (!def || (def.admin && !admin)) { line("Unknown command: " + cmd, "e"); return; }
    if (c === "/cheats") { for (const x of COMMANDS) if (!x.admin || admin) line(x.name.padEnd(21) + x.about + (x.admin ? "  [admin]" : ""), x.admin ? "hl" : ""); return; }
    if (c === "/clear") { out.textContent = ""; return; }
    if (c === "/exit") { closeConsole(); return; }
    if (c === "/whoami") {
      const r = await send({ type: "DEV_CMD", cmd: "whoami" }, 8000);
      if (!r) { line("no answer from the extension", "e"); return; }
      admin = !!r.admin;
      line((r.user || "not connected") + (r.team ? " · " + r.team : "") + " · v" + r.version + (r.admin ? " · admin" : ""));
      return;
    }
    if (c === "/refresh") {
      line("refreshing…", "mu");
      const r = await send({ type: "DEV_CMD", cmd: "refresh" }, 120000);
      line(r && r.ok ? "done" : "failed: " + ((r && r.error) || "no answer"), r && r.ok ? "ok" : "e");
      return;
    }
    if (c === "/active") {
      const items = activeItems();
      if (!items.length) { line("nothing switched on", "mu"); return; }
      const how = { queue: "/autorun stop", marks: "/autocomplete clear  (one: /autocomplete off <n> from /autocomplete list)", boxes: "/autocomplete boxes off" };
      for (const it of items) line(it.text.padEnd(42) + "off: " + how[it.key], "hl");
      line("/off switches all of it off", "mu");
      return;
    }
    if (c === "/off") { await allOff(); line("everything switched off", "ok"); return; }
    if (c === "/autocomplete") return autocomplete(arg);
    if (c === "/autorun") return autorun(arg);
    const r = await send({ type: "DEV_CMD", cmd: c.slice(1) }, 180000);
    if (!r || r.unknown) { line("Unknown command: " + cmd, "e"); return; }
    if (c === "/policy") {
      const p = r.policy || {}, ui = r.info || {};
      line("latest " + p.latest + "   installed " + chrome.runtime.getManifest().version + (ui.newer ? "   (update available)" : ""));
      line("quietFor " + JSON.stringify(p.quietFor || "") + "   important " + !!p.important + "   autoInstallAfterHours " + p.autoInstallAfterHours + "   holdUntil " + (p.holdUntil ? new Date(p.holdUntil).toLocaleString() : 0));
      line("notifiedAllAt " + (p.notifiedAllAt ? new Date(p.notifiedAllAt).toLocaleString() : "-") + "   nonce " + (p.notifyNonce || "-") + (p.preview ? "   preview " + JSON.stringify(p.preview) : ""), "mu");
      return;
    }
    if (c === "/autoupdate") {
      if (r.upToDate) { line("up to date (v" + r.current + ")", "ok"); return; }
      const st = r.state || {};
      line("v" + r.latest + ": " + (st.installedAt ? "installed - restarting" : (st.reason || "tried")), st.installedAt ? "ok" : "e");
      for (const s of st.trace || []) line("  " + s, "mu");
      return;
    }
    if (c === "/cacheclear") { line("cleared - refreshing in the background", "ok"); return; }
  }

  // ---------- /autocomplete ----------
  async function openTasksWithEstimate() {
    const g = await chrome.storage.local.get(["clickupState", "insOpenCache", "settings"]).catch(() => ({}));
    const st = g.clickupState || {};
    const cfgIds = new Set(((g.settings && g.settings.clickupDeadlineTaskUrls) || []).map((u) => (String(u).match(/\/t\/([^/?#]+)/) || [])[1]).filter(Boolean));
    const byId = new Map();
    const take = (t) => {
      if (!t || t.id == null || t.done || t.local || /^rev-/.test(String(t.id))) return;
      const est = Number(t.totalEstimateMs || t.estimateMs) || 0;
      if (!(est > 0) || EXTRA_RE.test(t.name || "") || cfgIds.has(String(t.id))) return;
      const id = String(t.id);
      if (!byId.has(id)) byId.set(id, { id, name: t.name || "(untitled task)", est, due: Number(t.dueDateMs) || 0, client: t.client || "", shared: (Number(t.assigneeCount) || (Array.isArray(t.assignees) ? t.assignees.length : 0)) > 1 });
    };
    for (const b of [st, st.todayFilter, st.thisWeek, st.nextWeek, st.tomorrow]) if (b) for (const t of b.tasks || []) take(t);
    for (const t of (g.insOpenCache && g.insOpenCache.tasks) || []) take(t);
    return [...byId.values()].sort((a, b) => (a.due || 9e15) - (b.due || 9e15));
  }
  async function saveMarks(next) { marked = next; await chrome.storage.local.set({ autoCompleteTasks: next }); paintRows(); }
  async function autocomplete(arg) {
    if (arg === "list") {
      const ids = Object.keys(marked);
      if (!ids.length) { line("no tasks marked", "mu"); return; }
      ids.forEach((id, i) => line((i + 1) + ". " + marked[id].name, "hl"));
      return;
    }
    if (arg === "clear") { await saveMarks({}); line("all unmarked", "ok"); return; }
    const offN = /^off\s+(\d+)$/.exec(arg);
    if (offN) {
      const ids = Object.keys(marked), id = ids[Number(offN[1]) - 1];
      if (!id) { line("no task " + offN[1] + " in /autocomplete list", "e"); return; }
      const next = { ...marked }; const nm = next[id].name; delete next[id];
      await saveMarks(next);
      line("unmarked: " + nm, "ok");
      return;
    }
    if (arg === "boxes" || arg === "boxes on") {
      await chrome.storage.local.set({ acBoxes: true }); boxes = true; paintRows();
      line("tick boxes on - tick a task in the table to mark it (/autocomplete boxes off to hide them)", "ok");
      return;
    }
    if (arg === "boxes off") {
      await chrome.storage.local.set({ acBoxes: false }); boxes = false; paintRows();
      line("tick boxes hidden - marked tasks stay marked (/autocomplete clear unmarks them)", "ok");
      return;
    }
    const list = await openTasksWithEstimate();
    if (!list.length) { line("no open tasks with an estimate found - open the dashboard once so your tasks load", "e"); return; }
    const pick = new Set(Object.keys(marked).filter((id) => list.some((t) => t.id === id)));
    const show = () => {
      list.forEach((t, i) => line(String(i + 1).padStart(3) + ". [" + (pick.has(t.id) ? "x" : " ") + "] " + t.name.slice(0, 70) + "  · est " + fmt(t.est) + " · " + day(t.due) + (t.client ? " · " + t.client : "") + (t.shared ? "  (shared)" : ""), pick.has(t.id) ? "hl" : ""));
      line("numbers to tick/untick (1 3 5, 2-4), all, none - Enter on an empty line saves, Esc cancels", "mu");
    };
    show();
    setMode({
      name: "autocomplete",
      input: async (v) => {
        if (!v) {
          const next = {};
          for (const id of Object.keys(marked)) if (!list.some((t) => t.id === id)) next[id] = marked[id]; // keep ones not in this list
          for (const t of list) if (pick.has(t.id)) next[t.id] = { name: t.name, at: (marked[t.id] && marked[t.id].at) || Date.now() };
          await saveMarks(next);
          const n = list.filter((t) => pick.has(t.id));
          line(n.length ? "saved - " + n.length + " task" + (n.length === 1 ? "" : "s") + " will complete at the estimate" : "saved - none marked", "ok");
          const sh = n.filter((t) => t.shared);
          if (sh.length) line("note: " + sh.length + " of them " + (sh.length === 1 ? "is" : "are") + " shared - completing finishes it for everyone on it", "mu");
          setMode(null);
          return;
        }
        if (/^all$/i.test(v)) list.forEach((t) => pick.add(t.id));
        else if (/^none$/i.test(v)) pick.clear();
        else {
          for (const part of v.split(/[\s,]+/)) {
            const m = /^(\d+)(?:-(\d+))?$/.exec(part);
            if (!m) { line("? " + part, "e"); continue; }
            const a = Number(m[1]), b = m[2] ? Number(m[2]) : a;
            for (let i = Math.min(a, b); i <= Math.max(a, b); i++) { const t = list[i - 1]; if (!t) continue; if (pick.has(t.id)) pick.delete(t.id); else pick.add(t.id); }
          }
        }
        out.textContent = "";
        show();
      },
    });
  }

  // ---------- /autorun ----------
  async function autorun(arg) {
    const g = await chrome.storage.local.get("autoRunQueue").catch(() => ({}));
    const q = g && g.autoRunQueue;
    if (arg === "list") {
      if (!q || !q.ids || !q.ids.length) { line("no queue running", "mu"); return; }
      const done = q.total - q.ids.length;
      line(done + " of " + q.total + " done" + (q.paused ? " - PAUSED (couldn't start the next task)" : ""), q.paused ? "e" : "ok");
      q.ids.forEach((id, i) => line((i === 0 ? "▶ " : "  ") + (done + i + 1) + ". " + ((q.names && q.names[id]) || id), i === 0 ? "hl" : ""));
      return;
    }
    if (arg === "stop") {
      await send({ type: "DEV_CMD", cmd: "autorun-stop" }, 8000);
      line("queue stopped - the running timer keeps going; queued tasks stay marked for auto-complete (/autocomplete clear unmarks them)", "ok");
      return;
    }
    if (q && q.ids && q.ids.length) { line("a queue is already running (" + (q.total - q.ids.length) + " of " + q.total + " done) - /autorun stop first", "e"); return; }
    const list = await openTasksWithEstimate();
    if (!list.length) { line("no open tasks with an estimate found - open the dashboard once so your tasks load", "e"); return; }
    list.forEach((t, i) => line(String(i + 1).padStart(3) + ". " + t.name.slice(0, 70) + "  · est " + fmt(t.est) + " · " + day(t.due) + (t.client ? " · " + t.client : "") + (t.shared ? "  (shared)" : "")));
    line("type the task numbers IN THE ORDER to run them (e.g. 3 1 2) - Esc cancels", "mu");
    let order = [];
    setMode({
      name: "autorun",
      input: async (v) => {
        if (!order.length) {
          const seen = new Set();
          for (const part of v.split(/[\s,]+/)) {
            const n = Number(part);
            const t = Number.isInteger(n) ? list[n - 1] : null;
            if (!t) { if (part) line("? " + part, "e"); continue; }
            if (!seen.has(t.id)) { seen.add(t.id); order.push(t); }
          }
          if (!order.length) { line("pick at least one task by its number", "e"); return; }
          const total = order.reduce((a, t) => a + t.est, 0);
          line("queue:", "hl");
          order.forEach((t, i) => line("  " + (i + 1) + ". " + t.name.slice(0, 70) + "  · " + fmt(t.est), "hl"));
          line("about " + fmt(total) + " in all. Each time entry is labelled \"Auto-run queue\" in ClickUp. Start now? (y/n)", "mu");
          return;
        }
        if (/^y(es)?$/i.test(v)) {
          const names = {}; for (const t of order) names[t.id] = t.name;
          const r = await send({ type: "DEV_CMD", cmd: "autorun-start", ids: order.map((t) => t.id), names }, 30000);
          line(r && r.ok ? "started - \"" + order[0].name.slice(0, 60) + "\" is running (/autorun list to follow it)" : "couldn't start: " + ((r && r.error) || "no answer"), r && r.ok ? "ok" : "e");
          setMode(null);
          return;
        }
        line("not started", "mu");
        setMode(null);
      },
    });
  }

  document.addEventListener("keydown", (e) => {
    if (e.ctrlKey && e.shiftKey && !e.altKey && e.code === "Backquote") { e.preventDefault(); if (box) closeConsole(); else openConsole(); }
  }, true);
})();
