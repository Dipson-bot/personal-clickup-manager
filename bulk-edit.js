// Options > Bulk edit: pick tasks (range / client / status / search), tick the
// ones to change, then change their due date, status, priority or estimate in
// one go. One task at a time through the background (CLICKUP_BULK_ONE, which
// waits out ClickUp's rate limit), a single refresh at the end, and Undo from
// the old values each change reports back.
(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  if (!$("bulkCard")) return;
  const send = (msg, ms = 30000) => new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), ms);
    try { chrome.runtime.sendMessage(msg, (r) => { clearTimeout(t); void chrome.runtime.lastError; resolve(r || null); }); }
    catch (e) { clearTimeout(t); resolve(null); }
  });
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const fmtDur = (ms) => { const m = Math.round((Number(ms) || 0) / 60000); const h = Math.floor(m / 60); return h ? h + "h" + (m % 60 ? " " + (m % 60) + "m" : "") : m + "m"; };
  const fmtShort = (ms) => new Date(ms).toLocaleDateString([], { month: "short", day: "numeric" });
  const fmtDay = (ms) => (ms ? new Date(ms).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" }) : "no date");
  const isoDay = (ms) => { const d = new Date(ms); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };
  const fromIso = (v) => { const [y, m, d] = String(v).split("-").map(Number); return new Date(y, m - 1, d).getTime(); };
  const DONE_RE = /^(closed|done|complete|completed|resolved|shipped|approved)$/i;
  const isDone = (t) => !!(t && (t.done || DONE_RE.test(String(t.status || "").trim())));
  const clientOf = (t) => String((t && (t.client || (t.container && t.container.listName))) || "").trim();

  let tasks = [];          // loaded rows
  const picked = new Set(); // ticked task ids
  const results = new Map(); // taskId -> "ok" | "no" | "skip" (+ title)
  let loadSeq = 0;
  let running = false;

  // ---------- ranges (week follows Options > "A week runs") ----------
  const WEEK_MODES = { "sun-sat": [0, 7], "mon-sun": [1, 7], "mon-fri": [1, 5], "sun-thu": [0, 5] };
  let weekMode = "sun-sat";
  chrome.storage.local.get("settings").then((g) => { const m = g.settings && g.settings.clickupWeekMode; if (WEEK_MODES[m]) weekMode = m; }).catch(() => {});
  function range(kind) {
    const day0 = new Date(); day0.setHours(0, 0, 0, 0);
    const span = (from, days) => { const e = new Date(from); e.setDate(e.getDate() + days - 1); e.setHours(23, 59, 59, 999); return { fromTs: from.getTime(), toTs: e.getTime() }; };
    if (kind === "today") return span(day0, 1);
    if (kind === "tomorrow") { const d = new Date(day0); d.setDate(d.getDate() + 1); return span(d, 1); }
    if (kind === "week" || kind === "nextweek") {
      const [startDow, len] = WEEK_MODES[weekMode] || WEEK_MODES["sun-sat"];
      const s = new Date(day0); s.setDate(s.getDate() - ((s.getDay() - startDow + 7) % 7));
      if (kind === "nextweek") s.setDate(s.getDate() + 7);
      return span(s, len);
    }
    if (kind === "custom") {
      const f = $("bkFrom").value, t = $("bkTo").value;
      if (!f || !t) return null;
      const a = new Date(fromIso(f)), b = fromIso(t);
      return span(a, Math.max(1, Math.round((b - a.getTime()) / 86400000) + 1));
    }
    return null;
  }

  // ---------- load ----------
  async function load(force) {
    const seq = ++loadSeq;
    const kind = $("bkRange").value;
    $("bkCustom").hidden = kind !== "custom";
    const list = $("bkList");
    list.innerHTML = '<div class="hint" style="padding:14px;">Loading from ClickUp…</div>';
    let res = null;
    if (kind === "overdue") {
      res = await send({ type: "CLICKUP_OVERDUE", force: !!force }, 40000);
    } else if (kind === "any") {
      // Every open task, with or without dates - the only way to find tasks
      // that have no due date at all.
      res = await send({ type: "CLICKUP_OPEN_TASKS", force: !!force }, 60000);
    } else {
      const r = range(kind);
      if (!r) { list.innerHTML = '<div class="hint" style="padding:14px;">Pick both dates.</div>'; return; }
      for (let i = 0; i < 20; i++) {
        res = await send({ type: "CLICKUP_FILTER", fromTs: r.fromTs, toTs: r.toTs, assigneeIds: [], force: !!force && i === 0 }, 20000);
        if (seq !== loadSeq) return;
        if (!res || !res.ok || res.data) break;
        await new Promise((z) => setTimeout(z, 2000));
      }
      if (res && res.ok && res.data) {
        const inRange = (t) => { const x = Number(t && t.dueDateMs) || 0; return x >= r.fromTs && x <= r.toTs; };
        res = { ok: true, data: { tasks: (res.data.tasks || []).filter(inRange) } };
      }
    }
    if (seq !== loadSeq) return;
    if (!res || !res.ok || !res.data) {
      const why = res && (res.error || res.reason);
      list.innerHTML = '<div class="hint" style="padding:14px;color:var(--red);">Couldn\'t load tasks' + (why ? " (" + esc(why) + ")" : "") + ". Try ↻ in a minute.</div>";
      tasks = [];
      renderCount();
      return;
    }
    const seen = new Set();
    tasks = (res.data.tasks || []).filter((t) => t && t.id && !seen.has(String(t.id)) && seen.add(String(t.id)));
    tasks.sort((a, b) => (Number(a.dueDateMs) || 0) - (Number(b.dueDateMs) || 0));
    for (const id of [...picked]) if (!tasks.some((t) => String(t.id) === id)) picked.delete(id);
    fillFacets();
    render();
  }

  function fillFacets() {
    const keep = (sel, values, first) => {
      const cur = sel.value;
      sel.innerHTML = first + values.map((v) => '<option value="' + esc(v) + '">' + esc(v) + "</option>").join("");
      if ([...sel.options].some((o) => o.value === cur)) sel.value = cur;
    };
    keep($("bkClient"), [...new Set(tasks.map(clientOf).filter(Boolean))].sort((a, b) => a.localeCompare(b)), '<option value="">All clients</option>');
    const statuses = [...new Set(tasks.map((t) => String(t.status || "").trim()).filter(Boolean))].sort();
    keep($("bkStatus"), statuses, '<option value="open">All not done</option><option value="">Any status</option>');
    const common = ["to do", "in progress", "complete"];
    const all = [...new Set([...statuses.map((s) => s.toLowerCase()), ...common])];
    keep($("bkStatusVal"), all, "");
  }

  function shown() {
    const client = $("bkClient").value, status = $("bkStatus").value, q = $("bkSearch").value.trim().toLowerCase();
    const missing = $("bkMissing").value;
    return tasks.filter((t) => {
      if (client && clientOf(t) !== client) return false;
      if (missing === "due" && t.dueDateMs) return false;
      if (missing === "start" && t.startDateMs) return false;
      if (missing === "est" && Number(t.estimateMs) > 0) return false;
      if (status === "open" && isDone(t)) return false;
      if (status && status !== "open" && String(t.status || "").trim() !== status) return false;
      if (q && !(String(t.name || "").toLowerCase().includes(q) || clientOf(t).toLowerCase().includes(q))) return false;
      return true;
    });
  }

  function render() {
    const rows = shown();
    const list = $("bkList");
    if (!rows.length) {
      list.innerHTML = '<div class="hint" style="padding:14px;">' + (tasks.length ? "No tasks match these filters." : "No tasks in this range.") + "</div>";
      renderCount();
      return;
    }
    list.innerHTML = rows.map((t) => {
      const id = String(t.id);
      const r = results.get(id);
      const mark = r ? '<span class="res ' + r.kind + '" title="' + esc(r.title || "") + '">' + (r.kind === "ok" ? "✓" : r.kind === "skip" ? "–" : "✗") + "</span>" : '<span class="res"></span>';
      return '<div class="bk-row" data-id="' + esc(id) + '"><input type="checkbox"' + (picked.has(id) ? " checked" : "") + ' aria-label="Select" />' +
        '<a class="nm" href="' + esc(t.url || "https://app.clickup.com/t/" + encodeURIComponent(id)) + '" target="_blank" rel="noopener" title="' + esc(t.name) + '">' + (t.isSubtask ? "↳ " : "") + esc(t.name || "(task)") + "</a>" +
        '<span class="cl" title="' + esc(clientOf(t)) + '">' + esc(clientOf(t)) + "</span>" +
        '<span class="st">' + esc(t.status || "") + (t.priority ? " · " + esc(t.priority) : "") + "</span>" +
        '<span class="du">' +
        '<span class="bk-start' + (t.startDateMs ? "" : " bk-miss") + '" role="button" tabindex="0" title="Start date - click to change">' + (t.startDateMs ? "from " + esc(fmtShort(t.startDateMs)) : "+ start") + "</span>" +
        '<span class="bk-due' + (t.dueDateMs ? "" : " bk-miss") + '" role="button" tabindex="0" title="Due date - click to change">' + (t.dueDateMs ? esc(fmtDay(t.dueDateMs)) : "+ due") + "</span>" +
        '<span class="bk-est' + (Number(t.estimateMs) > 0 ? "" : " bk-miss") + '" role="button" tabindex="0" title="Estimate - click to change (e.g. 1h 30m, 45m, 1.5h)">' + (Number(t.estimateMs) > 0 ? esc(fmtDur(t.estimateMs)) : "+ est") + "</span>" +
        "</span>" + mark + "</div>";
    }).join("");
    renderCount();
  }
  function renderCount() {
    const rows = shown();
    const sel = rows.filter((t) => picked.has(String(t.id))).length;
    $("bkCount").textContent = rows.length ? sel + " of " + rows.length + " selected" : "";
    $("bkAll").checked = rows.length > 0 && sel === rows.length;
    $("bkAll").indeterminate = sel > 0 && sel < rows.length;
    const n = [...picked].filter((id) => tasks.some((t) => String(t.id) === id)).length;
    $("bkApply").disabled = running || n === 0;
    $("bkApply").textContent = "Apply to " + n + " task" + (n === 1 ? "" : "s");
  }

  // ---------- the change ----------
  function change() {
    const kind = $("bkKind").value;
    if (kind === "due" || kind === "start") {
      const what = kind === "due" ? "due date" : "start date";
      const mode = $("bkDueMode").value;
      if (mode === "set") {
        if (!$("bkDueDate").value) return { error: "Pick a date." };
        const dayMs = fromIso($("bkDueDate").value);
        return { change: { kind, mode, dayMs }, text: "set the " + what + " of {n} to " + fmtDay(dayMs) };
      }
      if (mode === "shift") {
        const days = Math.round(Number($("bkShift").value));
        if (!Number.isFinite(days) || !days) return { error: "Enter a number of days, like 2 or -1." };
        return { change: { kind, mode, days }, text: "move the " + what + " of {n} " + (days > 0 ? "later" : "earlier") + " by " + Math.abs(days) + " day" + (Math.abs(days) === 1 ? "" : "s") };
      }
      return { change: { kind, mode: "clear" }, text: "remove the " + what + " of {n}" };
    }
    if (kind === "status") {
      const v = $("bkStatusVal").value;
      if (!v) return { error: "Pick a status." };
      return { change: { kind, value: v }, text: "set the status of {n} to “" + v + "”" };
    }
    if (kind === "priority") {
      const v = $("bkPrioVal").value;
      return { change: { kind, value: v }, text: v === "none" ? "remove the priority of {n}" : "set the priority of {n} to " + v };
    }
    const h = Number($("bkEstH").value) || 0, m = Number($("bkEstM").value) || 0;
    if (h < 0 || m < 0 || h + m === 0) return { error: "Enter hours and/or minutes." };
    const ms = (h * 60 + m) * 60000;
    return { change: { kind: "estimate", ms }, text: "set the estimate of {n} to " + fmtDur(ms) };
  }
  function paintKind() {
    const k = $("bkKind").value;
    $("bkDueOpts").hidden = k !== "due" && k !== "start";
    $("bkStatusOpts").hidden = k !== "status";
    $("bkPrioOpts").hidden = k !== "priority";
    $("bkEstOpts").hidden = k !== "estimate";
    const mode = $("bkDueMode").value;
    $("bkDueDate").hidden = mode !== "set";
    $("bkShiftWrap").hidden = mode !== "shift";
  }

  async function runBatch(items, makeChange, label) {
    running = true;
    renderCount();
    const res = $("bkResult");
    res.hidden = false;
    const undo = [];
    let ok = 0, skip = 0, fail = 0;
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      res.textContent = label + "… " + (i + 1) + " of " + items.length;
      const r = await send({ type: "CLICKUP_BULK_ONE", taskId: it.id, change: makeChange(it) }, 120000);
      if (r && r.ok) { ok++; results.set(it.id, { kind: "ok" }); if (r.before) undo.push({ id: it.id, name: it.name, before: r.before }); }
      else if (r && r.skipped) { skip++; results.set(it.id, { kind: "skip", title: r.error || "skipped" }); }
      else { fail++; results.set(it.id, { kind: "no", title: (r && (r.error || r.reason)) || "no reply" }); }
      render();
    }
    send({ type: "CLICKUP_REFRESH", includeTasks: true, forceWeeks: true }, 60000);
    running = false;
    return { ok, skip, fail, undo };
  }

  $("bkApply").onclick = () => {
    const c = change();
    const box = $("bkConfirm");
    box.hidden = false;
    if (c.error) { box.innerHTML = '<span style="color:var(--red)">' + esc(c.error) + "</span>"; return; }
    const ids = [...picked].filter((id) => tasks.some((t) => String(t.id) === id));
    const n = ids.length + " task" + (ids.length === 1 ? "" : "s");
    box.innerHTML = "<span>This will " + esc(c.text.replace("{n}", n)) + ".</span>";
    const yes = document.createElement("button"); yes.className = "primary"; yes.textContent = "Yes, change them";
    const no = document.createElement("button"); no.textContent = "Cancel";
    no.onclick = () => { box.hidden = true; };
    yes.onclick = async () => {
      box.hidden = true;
      results.clear();
      const items = ids.map((id) => { const t = tasks.find((x) => String(x.id) === id); return { id, name: (t && t.name) || "" }; });
      const out = await runBatch(items, () => c.change, "Changing");
      if (out.undo.length) {
        try { await chrome.storage.local.set({ bulkUndo: { at: Date.now(), text: c.text.replace("{n}", n), items: out.undo } }); } catch (e) {}
      }
      showSummary(out, true);
      await load(true);
    };
    box.append(yes, no);
  };

  function showSummary(out, canUndo) {
    const res = $("bkResult");
    res.hidden = false;
    res.innerHTML = "<span>" + out.ok + " changed" + (out.skip ? ", " + out.skip + " skipped" : "") + (out.fail ? ", <b style='color:var(--red)'>" + out.fail + " failed</b> (point at ✗ for why)" : "") + ".</span>";
    if (canUndo && out.undo.length) {
      const u = document.createElement("button");
      u.textContent = "Undo";
      u.title = "Put back the old values of the tasks just changed";
      u.onclick = undoLast;
      res.appendChild(u);
    }
  }
  async function undoLast() {
    let saved = null;
    try { saved = (await chrome.storage.local.get("bulkUndo")).bulkUndo; } catch (e) {}
    if (!saved || !Array.isArray(saved.items) || !saved.items.length) { $("bkResult").textContent = "Nothing to undo."; return; }
    results.clear();
    const out = await runBatch(saved.items, (it) => ({ kind: "restore", before: it.before }), "Undoing");
    try { await chrome.storage.local.remove("bulkUndo"); } catch (e) {}
    $("bkResult").innerHTML = "<span>Undone: " + out.ok + " task" + (out.ok === 1 ? "" : "s") + " put back" + (out.fail ? ", " + out.fail + " couldn't be" : "") + ".</span>";
    await load(true);
  }

  // ---------- wiring ----------
  $("bkList").addEventListener("change", (e) => {
    const row = e.target.closest(".bk-row");
    if (!row || e.target.type !== "checkbox") return;
    if (e.target.checked) picked.add(row.dataset.id); else picked.delete(row.dataset.id);
    renderCount();
  });
  // One task's due date: click its date - the same calendar editor as the
  // dashboard's date chips (options.js startEditDueOpt; keeps the time of day,
  // Clear removes the date). The list redraws once the editor closes.
  const editOne = (chip) => {
    const row = chip.closest(".bk-row");
    const t = row && tasks.find((x) => String(x.id) === row.dataset.id);
    if (!t || running || typeof startEditDueOpt !== "function") return;
    startEditDueOpt(chip, t);
    const wait = setInterval(() => {
      if (chip._editing) return;
      clearInterval(wait);
      setTimeout(render, 600); // let "syncing" show briefly, then the full date
    }, 300);
  };
  // Start date and estimate: a small editor in place of the chip. Saved through
  // the same one-task change as the bulk tools (CLICKUP_BULK_ONE).
  const parseEst = (v) => {
    const s = String(v || "").trim().toLowerCase().replace(",", ".");
    if (!s) return 0;
    let m = 0, hit = false;
    const h = s.match(/(\d+(?:\.\d+)?)\s*h/); if (h) { m += Number(h[1]) * 60; hit = true; }
    const mm = s.match(/(\d+)\s*m/); if (mm) { m += Number(mm[1]); hit = true; }
    if (!hit && /^\d+(\.\d+)?$/.test(s)) m = Number(s) <= 12 && s.includes(".") ? Number(s) * 60 : Number(s); // "1.5" = hours, "45" = minutes
    return Math.round(m) * 60000;
  };
  async function saveOne(t, change, chip) {
    chip.textContent = "saving…";
    const r = await send({ type: "CLICKUP_BULK_ONE", taskId: String(t.id), change }, 90000);
    if (r && r.ok) {
      if (change.kind === "start") t.startDateMs = change.mode === "clear" ? null : new Date(new Date(change.dayMs).setHours(12, 0, 0, 0)).getTime();
      if (change.kind === "estimate") t.estimateMs = change.ms;
      results.set(String(t.id), { kind: "ok" });
      send({ type: "CLICKUP_REFRESH", includeTasks: true, forceWeeks: true }, 60000);
    } else {
      results.set(String(t.id), { kind: "no", title: (r && (r.error || r.reason)) || "no reply" });
    }
    render();
  }
  function editInline(chip) {
    const row = chip.closest(".bk-row");
    const t = row && tasks.find((x) => String(x.id) === row.dataset.id);
    if (!t || running || chip._editing) return;
    chip._editing = true;
    const isStart = chip.classList.contains("bk-start");
    const input = document.createElement("input");
    input.className = "bk-edit";
    if (isStart) {
      input.type = "date";
      if (t.startDateMs) input.value = isoDay(t.startDateMs);
      input.title = "Pick the start date (Clear = no start date). Esc cancels.";
    } else {
      input.type = "text";
      input.placeholder = "e.g. 1h 30m";
      input.value = Number(t.estimateMs) > 0 ? fmtDur(t.estimateMs) : "";
      input.title = "1h 30m, 45m or 1.5h, then Enter. Esc cancels.";
    }
    chip.textContent = "";
    chip.appendChild(input);
    input.focus();
    if (isStart) { try { input.showPicker(); } catch (e) {} }
    let done = false;
    const cancel = () => { if (done) return; done = true; chip._editing = false; render(); };
    const save = () => {
      if (done) return;
      done = true;
      chip._editing = false;
      if (isStart) {
        if (!input.value) { if (t.startDateMs) saveOne(t, { kind: "start", mode: "clear" }, chip); else render(); return; }
        const dayMs = fromIso(input.value);
        if (t.startDateMs && isoDay(t.startDateMs) === input.value) { render(); return; }
        saveOne(t, { kind: "start", mode: "set", dayMs }, chip);
      } else {
        const ms = parseEst(input.value);
        if (ms === (Number(t.estimateMs) || 0)) { render(); return; }
        saveOne(t, { kind: "estimate", ms }, chip);
      }
    };
    let lastKey = 0;
    input.addEventListener("keydown", (e) => {
      lastKey = Date.now();
      if (e.key === "Enter") { e.preventDefault(); save(); }
      else if (e.key === "Escape") { e.preventDefault(); cancel(); }
    });
    if (isStart) input.addEventListener("change", () => { if (Date.now() - lastKey > 400) save(); });
    input.addEventListener("blur", () => setTimeout(save, 0));
    input.addEventListener("click", (e) => e.stopPropagation());
  }
  $("bkList").addEventListener("click", (e) => {
    const chip = e.target.closest(".bk-due, .bk-start, .bk-est");
    if (!chip || chip._editing || e.target.tagName === "INPUT") return;
    e.preventDefault();
    if (chip.classList.contains("bk-due")) editOne(chip); else editInline(chip);
  });
  $("bkList").addEventListener("keydown", (e) => {
    const chip = e.target.closest && e.target.closest(".bk-due, .bk-start, .bk-est");
    if (!chip || chip._editing || e.target.tagName === "INPUT" || (e.key !== "Enter" && e.key !== " ")) return;
    e.preventDefault();
    if (chip.classList.contains("bk-due")) editOne(chip); else editInline(chip);
  });
  $("bkAll").onchange = () => {
    for (const t of shown()) { if ($("bkAll").checked) picked.add(String(t.id)); else picked.delete(String(t.id)); }
    render();
  };
  for (const id of ["bkClient", "bkStatus", "bkMissing"]) $(id).onchange = render;
  $("bkSearch").oninput = render;
  $("bkRange").onchange = () => load(false);
  $("bkFrom").onchange = $("bkTo").onchange = () => { if ($("bkFrom").value && $("bkTo").value) load(false); };
  $("bkReload").onclick = () => load(true);
  $("bkKind").onchange = paintKind;
  $("bkDueMode").onchange = paintKind;
  const tmr = new Date(); tmr.setDate(tmr.getDate() + 1);
  $("bkDueDate").value = isoDay(tmr.getTime());
  paintKind();

  // Load when the tab is first opened (not on every Options page load).
  let loaded = false;
  const panel = document.querySelector('.panel[data-panel="bulk"]');
  const maybeLoad = () => { if (!loaded && panel && panel.classList.contains("on")) { loaded = true; load(false); } };
  new MutationObserver(maybeLoad).observe(panel, { attributes: true, attributeFilter: ["class"] });
  maybeLoad();
  // A previous batch that can still be undone.
  chrome.storage.local.get("bulkUndo").then((g) => {
    const u = g.bulkUndo;
    if (!u || !u.items || !u.items.length || Date.now() - u.at > 7 * 86400000) return;
    const res = $("bkResult");
    res.hidden = false;
    res.innerHTML = "<span class='hint'>Last change: " + esc(u.text) + " (" + new Date(u.at).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) + ").</span>";
    const b = document.createElement("button"); b.textContent = "Undo it"; b.onclick = undoLast;
    res.appendChild(b);
  }).catch(() => {});
})();
