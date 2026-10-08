// Personal reminders: the ⏰ button next to the notification bell (popup, side
// panel, Options), the "Remind me" link in a task's details, and the
// Options > Reminders tab. Reminders are stored as `reminders` in local storage;
// the background schedules them, shows them (with Snooze / Done) and backs them
// up to Google Drive with the other settings.
(function () {
  "use strict";
  const MAX_TEXT = 200;
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  // "default-cups" was a withdrawn office reminder (background removes it on update).
  const getAll = async () => { try { const g = await chrome.storage.local.get("reminders"); return Array.isArray(g.reminders) ? g.reminders.filter((r) => !(r && r.id === "default-cups")) : []; } catch (e) { return []; } };
  const setAll = async (list) => { await chrome.storage.local.set({ reminders: list }); };
  const pad = (n) => String(n).padStart(2, "0");
  const toLocalInput = (ms) => { const d = new Date(ms); return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + "T" + pad(d.getHours()) + ":" + pad(d.getMinutes()); };
  const fromLocalInput = (v) => { const t = new Date(v).getTime(); return Number.isFinite(t) ? t : 0; };
  const REPEAT = { none: "Once", daily: "Every day", weekdays: "Weekdays", weekly: "Every week" };
  // Each reminder's own sound (the check in / check out ones default to Alarm).
  const SOUNDS = { normal: "Normal chime", danger: "Alarm", winner: "Celebration", none: "Silent" };
  // Next time after now for a repeating reminder (same time of day).
  function nextAt(at, repeat) {
    const d = new Date(Number(at) || Date.now());
    let guard = 0;
    while ((d.getTime() <= Date.now() || (repeat === "weekdays" && (d.getDay() === 0 || d.getDay() === 6))) && ++guard < 800) d.setDate(d.getDate() + (repeat === "weekly" ? 7 : 1));
    return d.getTime();
  }
  // Attached files live in IndexedDB on this computer (too big for settings
  // storage); a reminder keeps only { id, name, type, size } for each.
  const MAX_FILES = 10, MAX_FILE = 20 * 1048576;
  const fdb = () => new Promise((ok, bad) => {
    const rq = indexedDB.open("pcm-remfiles", 1);
    rq.onupgradeneeded = () => { const db = rq.result; if (!db.objectStoreNames.contains("files")) db.createObjectStore("files", { keyPath: "id" }); };
    rq.onsuccess = () => ok(rq.result); rq.onerror = () => bad(rq.error);
  });
  const fdo = async (mode, fn) => { const db = await fdb(); return new Promise((ok, bad) => { const tx = db.transaction("files", mode); const r = fn(tx.objectStore("files")); tx.oncomplete = () => { db.close(); ok(r && r.result); }; tx.onerror = () => { db.close(); bad(tx.error); }; }); };
  const filePut = (recs) => fdo("readwrite", (s) => { for (const r of recs) s.put(r); });
  const fileGet = (id) => fdo("readonly", (s) => s.get(id));
  const fileDel = (ids) => fdo("readwrite", (s) => { for (const id of ids) s.delete(id); });
  const fmtSize = (n) => n > 1048576 ? (n / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(n / 1024)) + " KB";
  // Remove files no remaining reminder uses (a snoozed copy shares its files) -
  // and no client note either (a reminder made from a note uses the note's files).
  async function dropUnusedFiles(removed, kept) {
    const used = new Set(); for (const r of kept) for (const f of (r && r.files) || []) used.add(f.id);
    try {
      const { clientNotes } = await chrome.storage.local.get("clientNotes");
      for (const list of Object.values(clientNotes && typeof clientNotes === "object" ? clientNotes : {})) for (const n of list || []) for (const f of (n && n.files) || []) used.add(f.id);
    } catch (e) {}
    const gone = []; for (const r of removed) for (const f of (r && r.files) || []) if (!used.has(f.id)) gone.push(f.id);
    if (gone.length) await fileDel(gone).catch(() => {});
  }
  async function openFile(meta) {
    const rec = await fileGet(meta.id).catch(() => null);
    if (!rec || !rec.blob) { alert("That file isn't on this computer (attached files aren't backed up to Drive)."); return; }
    const url = URL.createObjectURL(rec.blob);
    const a = document.createElement("a");
    a.href = url;
    if (/^(image\/|application\/pdf|text\/plain)/.test(rec.type || "")) a.target = "_blank"; else a.download = rec.name || "file";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
  function whenLabel(ms) {
    const d = new Date(ms), now = new Date();
    const day0 = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const diff = Math.round((day0(d) - day0(now)) / 86400000);
    const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    if (diff === 0) return "Today " + time;
    if (diff === 1) return "Tomorrow " + time;
    if (diff === -1) return "Yesterday " + time;
    return d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" }) + ", " + time;
  }
  const at9 = (daysAhead, weekday) => {
    const d = new Date(); d.setSeconds(0, 0);
    if (weekday != null) { let add = (weekday - d.getDay() + 7) % 7; if (add === 0) add = 7; d.setDate(d.getDate() + add); }
    else d.setDate(d.getDate() + daysAhead);
    d.setHours(9, 0, 0, 0);
    return d.getTime();
  };
  // Tasks the extension already knows (for linking a reminder to a task).
  async function knownTasks() {
    try {
      const { clickupState: st } = await chrome.storage.local.get("clickupState");
      if (!st) return [];
      const seen = new Map();
      for (const arr of [st.tasks, st.todayFilter && st.todayFilter.tasks, st.thisWeek && st.thisWeek.tasks, st.nextWeek && st.nextWeek.tasks, st.deadlineTasks]) {
        for (const t of Array.isArray(arr) ? arr : []) if (t && t.id && t.name && !seen.has(String(t.id))) seen.set(String(t.id), { id: String(t.id), name: String(t.name), url: t.url || "https://app.clickup.com/t/" + t.id });
      }
      return [...seen.values()];
    } catch (e) { return []; }
  }

  const css = document.createElement("style");
  css.textContent = `
    .rm-btn { border: none; background: none; cursor: pointer; font-size: 14px; padding: 2px 4px; line-height: 1; color: var(--text); position: relative; }
    .rm-btn .rm-n { position: absolute; top: -4px; right: -5px; min-width: 14px; height: 14px; padding: 0 3px; box-sizing: border-box; border-radius: 99px; background: var(--indigo); color: #fff; font: 700 9px/14px sans-serif; text-align: center; }
    .rm-pop { position: fixed; z-index: 1001; width: 300px; max-width: calc(100vw - 16px); background: var(--card); color: var(--text); border: 1px solid var(--border); border-radius: 10px; box-shadow: 0 12px 28px rgba(0,0,0,.2); padding: 10px; font-size: 12.5px; }
    .rm-pop h4 { margin: 0 0 8px; font-size: 12px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); display: flex; align-items: center; gap: 6px; }
    .rm-pop h4 a { margin-left: auto; text-transform: none; letter-spacing: 0; font-weight: 500; color: var(--indigo); cursor: pointer; font-size: 11.5px; }
    .rm-form { display: flex; flex-direction: column; gap: 7px; }
    .rm-form input[type=text], .rm-form input[type=datetime-local], .rm-form select { font: inherit; font-size: 12.5px; padding: 5px 8px; border-radius: 7px; border: 1px solid var(--border); background: var(--field, var(--card)); color: var(--text); box-sizing: border-box; width: 100%; min-width: 0; }
    .rm-form input:focus, .rm-form select:focus { outline: 2px solid var(--indigo); outline-offset: -1px; }
    .rm-chips { display: flex; flex-wrap: wrap; gap: 5px; }
    .rm-chip { font: inherit; font-size: 11.5px; padding: 3px 9px; border-radius: 99px; border: 1px solid var(--border); background: var(--bg2); color: var(--text); cursor: pointer; }
    .rm-chip.on { border-color: var(--indigo); color: var(--indigo); background: rgba(99,102,241,.12); }
    .rm-row2 { display: flex; gap: 6px; }
    .rm-row2 > * { flex: 1; }
    .rm-task { display: flex; align-items: center; gap: 6px; font-size: 11.5px; color: var(--muted); }
    .rm-task b { color: var(--text); font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
    .rm-task button { border: 0; background: none; color: var(--muted); cursor: pointer; padding: 0 2px; }
    .rm-foot { display: flex; align-items: center; gap: 8px; }
    .rm-foot .rm-msg { flex: 1; font-size: 11.5px; color: var(--muted); }
    .rm-foot .rm-msg.err { color: var(--red, #dc2626); }
    .rm-save { font: inherit; font-size: 12px; font-weight: 600; padding: 5px 14px; border-radius: 7px; border: 1px solid var(--indigo); background: var(--indigo); color: #fff; cursor: pointer; }
    .rm-list { margin-top: 14px; display: flex; flex-direction: column; }
    .rm-list h3 { margin: 12px 0 4px; font-size: 11px; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); display: flex; align-items: center; gap: 8px; }
    .rm-list h3 button { margin-left: auto; font: inherit; text-transform: none; letter-spacing: 0; font-size: 11.5px; border: 0; background: none; color: var(--indigo); cursor: pointer; }
    .rm-item { display: flex; align-items: flex-start; gap: 10px; padding: 8px 2px; border-top: 1px solid var(--border); }
    .rm-item:first-of-type { border-top: 0; }
    .rm-item .rm-t { flex: 1; min-width: 0; }
    .rm-item .rm-t div:first-child { font-weight: 600; overflow-wrap: anywhere; }
    .rm-item .rm-sub { font-size: 11.5px; color: var(--muted); margin-top: 2px; display: flex; flex-wrap: wrap; gap: 4px 10px; }
    .rm-item .rm-sub a { color: var(--indigo); }
    .rm-item.past .rm-t div:first-child { font-weight: 500; opacity: .7; }
    .rm-item button { flex: none; font: inherit; font-size: 11.5px; padding: 2px 8px; border-radius: 7px; border: 1px solid var(--border); background: var(--bg2); color: var(--text); cursor: pointer; }
    .rm-empty { color: var(--muted); font-style: italic; padding: 6px 2px; }
    .rm-files { display: flex; flex-wrap: wrap; gap: 5px; }
    .rm-file { display: inline-flex; align-items: center; gap: 4px; max-width: 100%; font-size: 11.5px; padding: 2px 4px 2px 8px; border: 1px solid var(--border); border-radius: 99px; background: var(--bg2); color: var(--text); cursor: pointer; }
    .rm-file span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 170px; }
    .rm-file button { border: 0; background: none; color: var(--muted); cursor: pointer; padding: 0 3px; }
    .rm-attach { font: inherit; font-size: 11.5px; padding: 3px 9px; border-radius: 7px; border: 1px solid var(--border); background: var(--bg2); color: var(--text); cursor: pointer; }
    .rm-form.over { outline: 2px dashed var(--indigo); outline-offset: 4px; border-radius: 6px; }
    .rm-item.focus { background: rgba(99,102,241,.1); border-radius: 8px; }
    .rm-item .rm-acts { flex: none; display: flex; gap: 6px; flex-wrap: wrap; justify-content: flex-end; }
    .rm-item.paused .rm-t div:first-child { opacity: .55; }
    .rm-item .rm-sub .rm-paused { color: var(--amber, #d97706); font-weight: 600; }
    .rm-item .rm-files { margin-top: 5px; }
  `;
  document.head.appendChild(css);

  // The add form. opts.task = { id, name, url } to link it to a task;
  // opts.at / opts.repeat / opts.sound prefill (Duplicate, Edit);
  // opts.editId = save over that reminder instead of adding one (Edit);
  // opts.noteId = the task note it was made from (that note shows its ⏰ time).
  function buildForm(opts, onSaved) {
    const f = el("form", "rm-form");
    const text = el("input");
    text.type = "text"; text.maxLength = MAX_TEXT; text.placeholder = "Remind me to…";
    if (opts && opts.text) text.value = String(opts.text).slice(0, MAX_TEXT); // e.g. from a client note
    f.appendChild(text);

    let task = opts && opts.task && opts.task.id ? { id: String(opts.task.id), name: String(opts.task.name || "Task"), url: opts.task.url || "https://app.clickup.com/t/" + opts.task.id } : null;
    const taskBox = el("div");
    const taskIn = el("input");
    taskIn.type = "text"; taskIn.placeholder = "Link a task (optional) - type to search";
    const listId = "rmTasks" + uid();
    taskIn.setAttribute("list", listId);
    const dl = el("datalist"); dl.id = listId;
    let tasks = [];
    knownTasks().then((t) => { tasks = t; dl.innerHTML = ""; for (const x of t.slice(0, 300)) { const o = el("option"); o.value = x.name; dl.appendChild(o); } });
    const paintTask = () => {
      taskBox.textContent = "";
      if (task) {
        const row = el("div", "rm-task");
        row.append("Task:", el("b", "", task.name));
        const x = el("button", "", "✕"); x.type = "button"; x.title = "Unlink the task";
        x.onclick = () => { task = null; paintTask(); };
        row.appendChild(x);
        taskBox.appendChild(row);
      } else taskBox.append(taskIn, dl);
    };
    taskIn.onchange = () => {
      const v = taskIn.value.trim().toLowerCase();
      const hit = tasks.find((t) => t.name.toLowerCase() === v);
      if (hit) { task = hit; if (!text.value.trim()) text.value = hit.name.slice(0, MAX_TEXT); paintTask(); }
    };
    paintTask();
    f.appendChild(taskBox);

    const chips = el("div", "rm-chips");
    const dt = el("input");
    dt.type = "datetime-local";
    const def = new Date(Date.now() + 60 * 60000); def.setMinutes(Math.ceil(def.getMinutes() / 5) * 5, 0, 0);
    dt.value = toLocalInput(opts && Number(opts.at) > 0 ? Number(opts.at) : def.getTime());
    const quick = [["In 15 min", () => Date.now() + 15 * 60000], ["In 1 hour", () => Date.now() + 60 * 60000], ["Tomorrow 9:00", () => at9(1)], ["Monday 9:00", () => at9(0, 1)]];
    for (const [label, fn] of quick) {
      const c = el("button", "rm-chip", label); c.type = "button";
      c.onclick = () => { dt.value = toLocalInput(fn()); chips.querySelectorAll(".rm-chip").forEach((x) => x.classList.toggle("on", x === c)); };
      chips.appendChild(c);
    }
    dt.oninput = () => chips.querySelectorAll(".rm-chip").forEach((x) => x.classList.remove("on"));
    f.appendChild(chips);
    const row2 = el("div", "rm-row2");
    const rep = el("select");
    for (const [v, l] of Object.entries(REPEAT)) { const o = el("option", "", l); o.value = v; rep.appendChild(o); }
    rep.title = "Repeat";
    if (opts && opts.repeat && REPEAT[opts.repeat]) rep.value = opts.repeat;
    row2.append(dt, rep);
    f.appendChild(row2);
    const row3 = el("div", "rm-row2");
    const snd = el("select");
    for (const [v, l] of Object.entries(SOUNDS)) { const o = el("option", "", "\uD83D\uDD14 " + l); o.value = v; snd.appendChild(o); }
    snd.title = "The sound this reminder plays (follows the volume setting)";
    snd.value = opts && opts.sound && SOUNDS[opts.sound] ? opts.sound : "normal";
    row3.append(snd);
    f.appendChild(row3);

    // Files: 📎, Ctrl+V a screenshot, or drop files on the card.
    // Files already stored elsewhere (a client note's screenshots) are reused, not copied.
    const pending = (opts && Array.isArray(opts.files) ? opts.files : []).map((m) => ({ ...m, existing: true }));
    const filesBox = el("div", "rm-files");
    const fileIn = el("input"); fileIn.type = "file"; fileIn.multiple = true; fileIn.hidden = true;
    const attach = el("button", "rm-attach", "\uD83D\uDCCE Attach"); attach.type = "button";
    attach.title = "Attach screenshots or files (you can also paste a screenshot with Ctrl+V, or drop files here)";
    const paintFiles = () => {
      filesBox.textContent = "";
      pending.forEach((p, i) => {
        const c = el("span", "rm-file"); c.title = p.name + " (" + fmtSize(p.size) + ")";
        c.appendChild(el("span", "", p.name));
        const x = el("button", "", "\u2715"); x.type = "button"; x.title = "Remove";
        x.onclick = () => { pending.splice(i, 1); paintFiles(); };
        c.appendChild(x); filesBox.appendChild(c);
      });
      filesBox.appendChild(attach);
    };
    const addFiles = (list) => {
      for (const f of [...list]) {
        if (pending.length >= MAX_FILES) { say("Up to " + MAX_FILES + " files per reminder.", true); break; }
        if (f.size > MAX_FILE) { say(f.name + " is over 20 MB.", true); continue; }
        const name = f.name && f.name !== "image.png" ? f.name : "screenshot-" + (() => { const d = new Date(); return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + "-" + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds()); })() + ".png";
        pending.push({ id: uid(), name, type: f.type || "application/octet-stream", size: f.size, blob: f });
      }
      paintFiles();
    };
    attach.onclick = () => fileIn.click();
    fileIn.onchange = () => { addFiles(fileIn.files || []); fileIn.value = ""; };
    f.addEventListener("paste", (e) => { const fl = [...((e.clipboardData && e.clipboardData.files) || [])]; if (fl.length) { e.preventDefault(); e.stopPropagation(); addFiles(fl); } });
    f.addEventListener("dragover", (e) => { e.preventDefault(); f.classList.add("over"); });
    f.addEventListener("dragleave", () => f.classList.remove("over"));
    f.addEventListener("drop", (e) => { e.preventDefault(); e.stopPropagation(); f.classList.remove("over"); addFiles((e.dataTransfer && e.dataTransfer.files) || []); });
    paintFiles();
    f.append(filesBox, fileIn);

    const foot = el("div", "rm-foot");
    const msg = el("span", "rm-msg");
    const save = el("button", "rm-save", "Save");
    save.type = "submit";
    foot.append(msg, save);
    f.appendChild(foot);
    const say = (t, bad) => { msg.textContent = t; msg.classList.toggle("err", !!bad); };

    f.onsubmit = async (e) => {
      e.preventDefault();
      const words = text.value.trim() || (task ? task.name : "") || (pending.length ? pending[0].name : "");
      if (!words) { say("Write what to remind you about.", true); text.focus(); return; }
      let at = fromLocalInput(dt.value);
      if (!at) { say("Pick a date and time.", true); return; }
      // "Weekdays" never starts on a weekend: move to the next Monday, same time.
      if (rep.value === "weekdays") { const d = new Date(at); while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1); at = d.getTime(); }
      if (at < Date.now() - 30000 && rep.value === "none") { say("That time has passed - pick a later one.", true); return; }
      const list = await getAll();
      const editing = opts && opts.editId ? list.find((x) => x && x.id === opts.editId) : null;
      const fresh = pending.filter((p) => !p.existing);
      if (fresh.length) {
        save.disabled = true; say("Saving files\u2026");
        try { await filePut(fresh.map((p) => ({ id: p.id, name: p.name, type: p.type, size: p.size, blob: p.blob, at: Date.now() }))); }
        catch (err) { save.disabled = false; say("Couldn't save the files (is the disk full?).", true); return; }
        save.disabled = false;
      }
      const rec = { text: words.slice(0, MAX_TEXT), at, repeat: rep.value, sound: snd.value, taskId: task ? task.id : "", taskName: task ? task.name : "", taskUrl: task ? task.url : "", ...(opts && opts.noteId ? { noteId: String(opts.noteId) } : {}), files: pending.map((p) => ({ id: p.id, name: p.name, type: p.type, size: p.size })), active: true };
      if (editing) {
        // Edit: same reminder, new details (a paused one stays paused).
        const oldFiles = editing.files || [];
        Object.assign(editing, rec, { done: false, paused: !!editing.paused, editedAt: Date.now() });
        delete editing.firedAt;
        try { await setAll(list); } catch (err) { say("Couldn't save it.", true); return; }
        await dropUnusedFiles([{ files: oldFiles.filter((f) => !editing.files.some((g) => g.id === f.id)) }], list);
        say("Saved \u2713 " + whenLabel(at));
        if (onSaved) onSaved();
        return;
      }
      list.push({ id: uid(), ...rec, createdAt: Date.now() });
      try { await setAll(list); } catch (err) { say("Couldn't save it.", true); return; }
      say("Saved \u2713 " + whenLabel(at));
      text.value = ""; pending.length = 0; paintFiles(); if (!(opts && opts.task)) { task = null; paintTask(); }
      if (onSaved) onSaved();
    };
    setTimeout(() => text.focus(), 30);
    return f;
  }

  // ---------- quick-add card ----------
  let pop = null;
  function closePop() { if (pop) { pop.remove(); pop = null; } }
  function open(opts, anchor) {
    closePop();
    pop = el("div", "rm-pop");
    pop.onclick = (e) => e.stopPropagation();
    const h = el("h4", "", (opts && opts.title) || "⏰ New reminder");
    const all = el("a", "", "All reminders");
    all.onclick = () => { closePop(); openList(); };
    h.appendChild(all);
    pop.append(h, buildForm(opts || {}, () => setTimeout(closePop, 900)));
    document.body.appendChild(pop);
    const r = anchor && anchor.getBoundingClientRect ? anchor.getBoundingClientRect() : null;
    const w = Math.min(300, window.innerWidth - 16);
    if (r && r.width) {
      pop.style.top = Math.round(Math.min(r.bottom + 6, window.innerHeight - pop.offsetHeight - 8)) + "px";
      pop.style.left = Math.round(Math.max(8, Math.min(window.innerWidth - w - 8, r.right - w))) + "px";
    } else {
      pop.style.top = Math.round(Math.max(8, (window.innerHeight - pop.offsetHeight) / 3)) + "px";
      pop.style.left = Math.round((window.innerWidth - w) / 2) + "px";
    }
  }
  function openList() {
    if (document.querySelector('.panel[data-panel="reminders"]') && typeof window.showOptTab === "function") { window.showOptTab("reminders"); return; }
    const url = chrome.runtime.getURL("options.html#reminders");
    try { chrome.tabs.create({ url }); } catch (e) { window.open(url, "_blank"); }
  }
  document.addEventListener("click", closePop);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && pop) closePop(); });

  // ---------- the ⏰ header button (next to the bell) ----------
  async function paintCount(btn) {
    const list = await getAll();
    const now = Date.now(), end = new Date(); end.setHours(23, 59, 59, 999);
    const today = list.filter((r) => r && r.active !== false && !r.done && r.at >= now && r.at <= end.getTime()).length;
    const upcoming = list.filter((r) => r && r.active !== false && !r.done).length;
    btn.title = upcoming ? upcoming + " upcoming reminder" + (upcoming === 1 ? "" : "s") + (today ? " (" + today + " today)" : "") + " - click to add one" : "Add a reminder";
    let n = btn.querySelector(".rm-n");
    if (today) { if (!n) { n = el("span", "rm-n"); btn.appendChild(n); } n.textContent = String(today); } else if (n) n.remove();
  }
  function initButton() {
    if (document.getElementById("remBtn")) return true;
    const bell = document.getElementById("notifyBell");
    if (!bell) return false;
    const btn = el("button", "rm-btn", "⏰");
    btn.id = "remBtn"; btn.type = "button";
    btn.onclick = (e) => { e.stopPropagation(); if (pop) closePop(); else open({}, btn); };
    bell.parentNode.insertBefore(btn, bell);
    paintCount(btn);
    chrome.storage.onChanged.addListener((ch, area) => { if (area === "local" && ch.reminders) paintCount(btn); });
    setInterval(() => paintCount(btn), 60000);
    return true;
  }

  // ---------- Options > Reminders ----------
  // options.html?rem=<id>#reminders (clicking a reminder that has files) highlights it.
  let focusId = "";
  try { focusId = new URLSearchParams(location.search).get("rem") || ""; } catch (e) {}
  async function renderPanel() {
    const formBox = document.getElementById("remForm"), listBox = document.getElementById("remList");
    if (!formBox || !listBox) return;
    if (!formBox.firstChild) formBox.appendChild(buildForm({}, null));
    const list = await getAll();
    const up = list.filter((r) => r && r.active !== false && !r.done).sort((a, b) => a.at - b.at);
    const past = list.filter((r) => r && (r.active === false || r.done)).sort((a, b) => (b.firedAt || b.at) - (a.firedAt || a.at)).slice(0, 30);
    listBox.textContent = "";
    const box = el("div", "rm-list");
    const section = (title, rows, isPast) => {
      const h = el("h3", "", title + " (" + rows.length + ")");
      if (isPast && rows.length) {
        const clr = el("button", "", "Clear past"); clr.type = "button";
        clr.onclick = async () => { const all = await getAll(); const kept = all.filter((r) => r && r.active !== false && !r.done); await setAll(kept); await dropUnusedFiles(all.filter((r) => !kept.includes(r)), kept); };
        h.appendChild(clr);
      }
      box.appendChild(h);
      if (!rows.length) { box.appendChild(el("div", "rm-empty", isPast ? "Nothing yet." : "No reminders yet. Save one above (or with ⏰ next to the bell) and it shows here with Duplicate and Delete buttons.")); return; }
      for (const r of rows) {
        const it = el("div", "rm-item" + (isPast ? " past" : ""));
        const t = el("div", "rm-t");
        t.appendChild(el("div", "", r.text || "Reminder"));
        const sub = el("div", "rm-sub");
        sub.appendChild(el("span", "", (isPast ? (r.done ? "Done · " : "Shown · ") : "") + whenLabel(isPast ? (r.firedAt || r.at) : r.at)));
        if (r.repeat && r.repeat !== "none") sub.appendChild(el("span", "", "↻ " + (REPEAT[r.repeat] || r.repeat)));
        if (r.sound && r.sound !== "normal") sub.appendChild(el("span", "", "\uD83D\uDD14 " + (SOUNDS[r.sound] || r.sound)));
        if (r.paused && !isPast) { sub.appendChild(el("span", "rm-paused", "\u23F8 Paused")); it.classList.add("paused"); }
        if (r.taskName) {
          const a = el("a", "", r.taskName);
          if (/^https:\/\/app\.clickup\.com\//.test(String(r.taskUrl || ""))) { a.href = r.taskUrl; a.target = "_blank"; a.rel = "noopener"; }
          sub.appendChild(a);
        }
        t.appendChild(sub);
        if (Array.isArray(r.files) && r.files.length) {
          const fb = el("div", "rm-files");
          for (const fm of r.files) {
            const c = el("span", "rm-file"); c.title = "Open " + fm.name + " (" + fmtSize(fm.size || 0) + ")";
            c.appendChild(el("span", "", "\uD83D\uDCCE " + fm.name));
            c.onclick = () => openFile(fm);
            fb.appendChild(c);
          }
          t.appendChild(fb);
        }
        if (r.id === focusId) { it.classList.add("focus"); setTimeout(() => it.scrollIntoView({ block: "center" }), 50); }
        // Duplicate: the same reminder in the quick-add card, ready to tweak and save.
        // A time that has passed moves to the same time on the next day to come.
        const dup = el("button", "", "Duplicate"); dup.type = "button";
        dup.title = "Make a copy of this reminder (change the time or text before saving)";
        dup.onclick = (e) => {
          e.stopPropagation(); // the page's outside-click would close the card straight away
          let at = Number(r.at) || Date.now();
          if (at < Date.now() + 60000) {
            const d = new Date(at), now = new Date();
            d.setFullYear(now.getFullYear(), now.getMonth(), now.getDate());
            if (d.getTime() < Date.now() + 60000) d.setDate(d.getDate() + 1);
            at = d.getTime();
          }
          open({ title: "⏰ Copy of reminder", text: r.text, at, repeat: r.repeat, sound: r.sound,
            task: r.taskId ? { id: r.taskId, name: r.taskName, url: r.taskUrl } : null,
            files: Array.isArray(r.files) ? r.files : [] }, dup);
        };
        const del = el("button", "", isPast ? "Remove" : "Delete"); del.type = "button";
        del.onclick = async () => { const all = await getAll(); const kept = all.filter((x) => x && x.id !== r.id); await setAll(kept); await dropUnusedFiles([r], kept); };
        // Edit: the same card, filled in; Save changes this reminder.
        const edit = el("button", "", "Edit"); edit.type = "button";
        edit.title = "Change the text, time, repeat, sound or files";
        edit.onclick = (e) => {
          e.stopPropagation();
          open({ title: "\u270E Edit reminder", editId: r.id, text: r.text, at: r.at, repeat: r.repeat, sound: r.sound,
            task: r.taskId ? { id: r.taskId, name: r.taskName, url: r.taskUrl } : null,
            files: Array.isArray(r.files) ? r.files : [] }, edit);
        };
        // Pause: stays in the list but doesn't pop up until resumed.
        const pause = el("button", "", r.paused ? "Resume" : "Pause"); pause.type = "button";
        pause.title = r.paused ? "Start this reminder again" : "Stop this reminder for now (it stays in the list)";
        pause.onclick = async () => {
          const all = await getAll();
          const x = all.find((y) => y && y.id === r.id);
          if (!x) return;
          x.paused = !x.paused;
          // Resuming a repeating one that was due while paused: its next time.
          if (!x.paused && Number(x.at) <= Date.now() && x.repeat && x.repeat !== "none") x.at = nextAt(x.at, x.repeat);
          await setAll(all);
        };
        const acts = el("div", "rm-acts");
        if (!isPast) acts.append(edit, pause);
        acts.append(dup, del);
        it.append(t, acts);
        box.appendChild(it);
      }
    };
    section("Upcoming", up, false);
    section("Past", past, true);
    listBox.appendChild(box);
    renderInbox();
  }

  // The other direction: task reminders teammates sent YOU. Kept in its own list
  // (nudgesIn in storage) rather than mixed into the reminders above, because they
  // aren't yours to edit, pause or delete - only to read and dismiss. Its own
  // function, not inlined into renderPanel, so a reminder arriving while this page
  // is open redraws just this section instead of rebuilding the whole tab (which
  // would take the focus with it).
  let inboxSub = false;
  function renderInbox() {
    const inbox = window.PcmNudgeInbox;
    if (!inbox || typeof inbox.render !== "function") return;
    const listBox = document.getElementById("remList");
    if (!listBox) return;
    const host = document.getElementById("nudgeList") || (() => {
      // options.html should carry the host; if it doesn't (an older page cached
      // alongside a newer script), make one rather than dropping the section.
      const h = document.createElement("div");
      h.id = "nudgeList";
      listBox.parentNode.insertBefore(h, listBox.nextSibling);
      return h;
    })();
    // Subscribe the first time there is something to draw into: this tab is a
    // separate reader from the notes panels and gets no redraw from there. The
    // storage event alone is too early - it arrives before task-notes.js has
    // re-read the list, so painting on it shows the previous list.
    if (!inboxSub && typeof inbox.onChange === "function") {
      inboxSub = true;
      try { inbox.onChange(renderInbox); } catch (e) {}
    }
    try { inbox.render(host, {}); } catch (e) {}
  }

  // Add a reminder straight away (e.g. "Remind me at…" while saving a client
  // note). files = metadata of files already in the store (they're shared).
  async function addReminder({ text, at, repeat, files, task }) {
    const when = Number(at);
    if (!String(text || "").trim() || !(when > Date.now() - 30000)) throw new Error("Pick a time that hasn't passed.");
    const list = await getAll();
    list.push({ id: uid(), text: String(text).trim().slice(0, MAX_TEXT), at: when, repeat: repeat || "none",
      taskId: task ? String(task.id) : "", taskName: task ? String(task.name || "") : "", taskUrl: task ? String(task.url || "") : "",
      files: (files || []).map((f) => ({ id: f.id, name: f.name, type: f.type, size: f.size })), active: true, createdAt: Date.now() });
    await setAll(list);
    return whenLabel(when);
  }
  window.PcmReminders = { open, openList, add: addReminder };
  const start = () => {
    if (!initButton()) { let n = 0; const iv = setInterval(() => { if (initButton() || ++n > 20) clearInterval(iv); }, 150); }
    renderPanel();
    chrome.storage.onChanged.addListener((ch, area) => {
      if (area !== "local") return;
      if (ch.reminders) renderPanel();
      // A reminder from a teammate arriving while this page is open. The notes panel
      // in task-notes.js sees it too, but this tab is a separate reader and gets no
      // redraw from there, so without this the list would sit stale until reload.
      if (ch.nudgesIn || ch.nudgeSeen) renderInbox();
    });
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();
})();
