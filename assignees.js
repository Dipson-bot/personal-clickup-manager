// Who's on a task (the avatars in a task row's WHO column): click them for a
// small list of everyone assigned, with ✕ to take a person off the task in
// ClickUp - like the ✕ on an assignee in ClickUp itself. Taking yourself off
// asks first, because the task then leaves your list. 🔔 sends that person a
// reminder about the task: their extension shows it (through the Team hub), or,
// if they don't use it, a ClickUp comment assigned to them.
// Works on the options dashboard, the popup and the side panel (every task row
// carries its task as row._cuTask).
(() => {
  "use strict";
  const send = (msg, ms) => new Promise((ok) => {
    let done = false;
    const to = setTimeout(() => { done = true; ok(null); }, ms || 30000);
    try { chrome.runtime.sendMessage(msg, (r) => { if (done) return; done = true; clearTimeout(to); void chrome.runtime.lastError; ok(r || null); }); } catch (e) { clearTimeout(to); ok(null); }
  });

  const css = document.createElement("style");
  css.textContent = `
  .cu-task .cu-who .av { cursor: pointer; }
  .cu-task .cu-who:hover .av { box-shadow: 0 0 0 1.5px var(--accent, #7c3aed); }
  .asg-pop { position: fixed; z-index: 1300; min-width: 220px; max-width: 300px; padding: 6px; border: 1px solid var(--border, #d4d4d8); border-radius: 10px; background: var(--card, #fff); color: var(--text, #111); box-shadow: 0 10px 28px rgba(0,0,0,.18); font-size: 12px; }
  .asg-pop .asg-h { padding: 3px 6px 6px; font-size: 10.5px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; color: var(--muted, #71717a); }
  .asg-pop .asg-r { display: flex; align-items: center; gap: 8px; padding: 4px 6px; border-radius: 7px; }
  .asg-pop .asg-r:hover { background: rgba(127,127,127,.1); }
  .asg-pop .asg-av { width: 20px; height: 20px; flex: none; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; font-size: 8.5px; font-weight: 700; color: #fff; }
  .asg-pop .asg-n { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .asg-pop .asg-x { flex: none; width: 20px; height: 20px; padding: 0; border: 0; border-radius: 50%; background: transparent; color: var(--muted, #71717a); font-size: 13px; line-height: 1; cursor: pointer; }
  .asg-pop .asg-x:hover:not(:disabled) { background: var(--red, #dc2626); color: #fff; }
  .asg-pop .asg-x:disabled { opacity: .4; cursor: default; }
  .asg-pop .asg-b { flex: none; width: 20px; height: 20px; padding: 0; border: 0; border-radius: 50%; background: transparent; font-size: 11px; line-height: 1; cursor: pointer; opacity: .75; }
  .asg-pop .asg-b:hover { background: rgba(245,158,11,.18); opacity: 1; }
  .asg-pop .asg-f { padding: 4px 6px 6px; }
  .asg-pop .asg-f textarea { box-sizing: border-box; width: 100%; min-height: 48px; resize: vertical; font: inherit; font-size: 12px; padding: 5px 7px; border: 1px solid var(--border, #d4d4d8); border-radius: 7px; background: var(--bg2, transparent); color: inherit; }
  .asg-pop .asg-f .asg-fb { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; }
  .asg-pop .asg-f button { font: inherit; font-size: 11px; font-weight: 600; padding: 2px 9px; border-radius: 6px; border: 1px solid var(--border, #d4d4d8); background: transparent; color: inherit; cursor: pointer; }
  .asg-pop .asg-f button.go { background: #f59e0b; border-color: #f59e0b; color: #fff; }
  .asg-pop .asg-f button:disabled { opacity: .5; cursor: default; }
  .asg-pop .asg-f .asg-fm { margin-top: 5px; font-size: 11.5px; color: var(--muted, #71717a); }
  .asg-pop .asg-f .asg-fm.err { color: var(--red, #dc2626); }
  .asg-pop .asg-f .asg-fm.ok { color: #16a34a; }
  .asg-pop .asg-msg { padding: 6px; font-size: 11.5px; color: var(--muted, #71717a); }
  .asg-pop .asg-msg.err { color: var(--red, #dc2626); }
  .asg-pop .asg-ask { padding: 6px; border-top: 1px solid var(--border, #e4e4e7); margin-top: 4px; font-size: 11.5px; }
  .asg-pop .asg-ask button { font: inherit; font-size: 11px; font-weight: 600; margin: 6px 6px 0 0; padding: 2px 9px; border-radius: 6px; border: 1px solid var(--border, #d4d4d8); background: transparent; color: inherit; cursor: pointer; }
  .asg-pop .asg-ask button.yes { background: var(--red, #dc2626); border-color: var(--red, #dc2626); color: #fff; }`;
  document.head.appendChild(css);

  const initials = (name) => {
    const w = String(name || "").split("@")[0].replace(/[._-]+/g, " ").trim().split(/\s+/).filter(Boolean);
    if (!w.length) return "?";
    return (w.length > 1 ? w[0][0] + w[w.length - 1][0] : w[0].slice(0, 2)).toUpperCase();
  };
  const color = (key) => { let h = 0; for (const ch of String(key || "")) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return "hsl(" + (h % 360) + ", 55%, 42%)"; };
  const nameOf = (a) => a.username || ("User " + a.id);

  let pop = null;
  const close = () => { if (pop) { pop.remove(); pop = null; } };

  // Take the person off every row of that task right away (a task can be listed
  // in more than one section); the saved lists are fixed in the background too.
  function dropEverywhere(t, a, self) {
    const id = String(t.id);
    for (const row of document.querySelectorAll(".cu-task")) {
      const rt = row._cuTask;
      if (!rt || String(rt.id) !== id) continue;
      if (self) { row.style.transition = "opacity .3s"; row.style.opacity = ".35"; row.title = "You're off this task - it leaves your list on the next refresh"; }
      dropFromRow(row, rt, a);
    }
  }
  function dropFromRow(row, t, a) {
    t.assignees = (t.assignees || []).filter((x) => String(x.id) !== String(a.id));
    const slot = row && row.querySelector(".cu-who");
    if (!slot) return;
    for (const c of slot.querySelectorAll(".av:not(.more)")) if (c.title === nameOf(a)) { c.remove(); break; }
    const more = slot.querySelector(".av.more");
    if (more) more.title = t.assignees.slice(1).map(nameOf).join(", ");
  }

  function open(slot, row, t) {
    close();
    const list = (Array.isArray(t.assignees) ? t.assignees : []).filter((a) => a && a.id);
    pop = document.createElement("div");
    pop.className = "asg-pop";
    pop.addEventListener("click", (e) => e.stopPropagation());
    const head = document.createElement("div");
    head.className = "asg-h";
    head.textContent = "Assigned to";
    pop.appendChild(head);
    const msg = document.createElement("div");
    msg.className = "asg-msg";
    const say = (text, err) => { msg.textContent = text; msg.className = "asg-msg" + (err ? " err" : ""); if (!msg.isConnected) pop.appendChild(msg); };
    if (!list.length) say("Nobody is assigned to this task.");
    const remove = async (a, r, x, confirmSelf) => {
      x.disabled = true;
      say("Taking " + nameOf(a) + " off the task…");
      const res = await send({ type: "CLICKUP_REMOVE_ASSIGNEE", taskId: String(t.id), userId: String(a.id), confirmSelf: !!confirmSelf }, 20000);
      if (res && res.reason === "self") {
        msg.remove();
        const ask = document.createElement("div");
        ask.className = "asg-ask";
        ask.textContent = "That's you - the task leaves your list once you're off it. Take yourself off?";
        const yes = document.createElement("button"); yes.type = "button"; yes.className = "yes"; yes.textContent = "Take me off";
        const no = document.createElement("button"); no.type = "button"; no.textContent = "Cancel";
        yes.onclick = () => { ask.remove(); remove(a, r, x, true); };
        no.onclick = () => { ask.remove(); x.disabled = false; };
        ask.append(document.createElement("br"), yes, no);
        pop.appendChild(ask);
        return;
      }
      if (!res || !res.ok) { x.disabled = false; say("Couldn't change it: " + ((res && res.error) || "no answer from ClickUp"), true); return; }
      r.remove();
      dropEverywhere(t, a, !!res.self);
      say(nameOf(a) + " is off the task in ClickUp.");
    };
    // 🔔: a short message, then send. Their extension shows it; without the
    // extension (or the hub), offer a ClickUp comment assigned to them.
    const remind = (a, r) => {
      const had = pop.querySelector(".asg-f");
      if (had) { const same = had._for === a.id; had.remove(); if (same) return; }
      const f = document.createElement("div");
      f.className = "asg-f";
      f._for = a.id;
      const ta = document.createElement("textarea");
      ta.maxLength = 300;
      ta.placeholder = "Reminder for " + nameOf(a).split(/\s+/)[0] + " (optional), e.g. please finish this today";
      const fb = document.createElement("div"); fb.className = "asg-fb";
      const go = document.createElement("button"); go.type = "button"; go.className = "go"; go.textContent = "Send reminder";
      const no = document.createElement("button"); no.type = "button"; no.textContent = "Cancel";
      const fm = document.createElement("div"); fm.className = "asg-fm";
      const note = (text, kind) => { fm.textContent = text; fm.className = "asg-fm" + (kind ? " " + kind : ""); if (!fm.isConnected) f.appendChild(fm); };
      const sendIt = async (via) => {
        go.disabled = true;
        note(via === "clickup" ? "Posting it in ClickUp…" : "Sending…");
        const res = await send({ type: "CLICKUP_NUDGE", via, taskId: String(t.id), userId: String(a.id), taskName: t.name || "", text: ta.value.trim() }, 30000);
        const alt = f.querySelector(".alt");
        if (alt) alt.remove();
        if (res && res.ok) {
          note(res.via === "clickup" ? "Posted as a ClickUp comment assigned to " + nameOf(a) + " - ClickUp notifies them." : "Sent - " + nameOf(a) + "'s extension shows it within a few minutes.", "ok");
          ta.disabled = true;
          no.textContent = "Close";
          return;
        }
        go.disabled = false;
        const why = res && res.reason;
        if (why === "no-extension" || why === "no-hub" || why === "old-hub") {
          note((why === "no-extension" ? nameOf(a) + " doesn't use the extension (or hasn't opened it since the Team hub was set up)." : res.error) + " Send it as a ClickUp comment assigned to them instead?");
          const b = document.createElement("button"); b.type = "button"; b.className = "go alt"; b.textContent = "Send as ClickUp comment";
          b.onclick = () => sendIt("clickup");
          fb.insertBefore(b, no);
          return;
        }
        note((res && res.error) || "No answer - try again.", "err");
      };
      go.onclick = () => sendIt("hub");
      no.onclick = () => f.remove();
      ta.addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); if (!go.disabled) sendIt("hub"); } });
      fb.append(go, no);
      f.append(ta, fb);
      r.after(f);
      ta.focus();
    };
    for (const a of list) {
      const r = document.createElement("div");
      r.className = "asg-r";
      const av = document.createElement("span");
      av.className = "asg-av";
      av.textContent = initials(a.username);
      av.style.background = color(a.id || a.username);
      const n = document.createElement("span");
      n.className = "asg-n";
      n.textContent = nameOf(a);
      n.title = nameOf(a);
      const x = document.createElement("button");
      x.type = "button";
      x.className = "asg-x";
      x.textContent = "✕";
      x.title = "Take " + nameOf(a) + " off this task (in ClickUp)";
      x.onclick = () => remove(a, r, x, false);
      const bell = document.createElement("button");
      bell.type = "button";
      bell.className = "asg-b";
      bell.textContent = "🔔";
      bell.title = "Send " + nameOf(a) + " a reminder about this task";
      bell.onclick = () => remind(a, r);
      r.append(av, n, bell, x);
      pop.appendChild(r);
    }
    document.body.appendChild(pop);
    const b = slot.getBoundingClientRect();
    const w = pop.offsetWidth || 220, h = pop.offsetHeight || 100;
    const vw = window.innerWidth || document.documentElement.clientWidth, vh = window.innerHeight || document.documentElement.clientHeight;
    pop.style.left = Math.max(8, Math.min(b.left, vw - w - 8)) + "px";
    pop.style.top = (b.bottom + 6 + h > vh && b.top - h - 6 > 0 ? b.top - h - 6 : b.bottom + 6) + "px";
  }

  document.addEventListener("click", (e) => {
    const slot = e.target && e.target.closest && e.target.closest(".cu-task .cu-who");
    if (!slot) { if (pop && !pop.contains(e.target)) close(); return; }
    const row = slot.closest(".cu-task");
    const t = row && row._cuTask;
    if (!t || t.id == null || t.local || /^rev-/.test(String(t.id)) || !(t.assignees || []).length) return;
    e.preventDefault();
    e.stopPropagation();
    if (pop && pop._slot === slot) { close(); return; }
    open(slot, row, t);
    pop._slot = slot;
  }, true);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && pop) close(); });
  window.addEventListener("scroll", close, true);
  window.addEventListener("resize", close);
})();
