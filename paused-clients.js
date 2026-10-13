// Paused clients: clients who have stopped working with us (for now). The Admin
// lists them (Admin › Paused clients, published to everyone through
// update-policy.json "pausedClients"); every task row of such a client - in any
// list, on the dashboard, the popup and the side panel - is struck through with a
// "Client paused" pill, and ▶ Start asks first, so nobody tracks time on it by
// mistake. Resuming the client (taking it off the list) puts the rows back.
// Nothing is changed in ClickUp.
(() => {
  "use strict";
  if (window.PcmPaused) return;
  // Letters and digits only, so "Acme Roofing", "🔥 ACME-ROOFING" and
  // "Acme Roofing SEO" are the same client.
  const key = (n) => String(n || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
  // What this person sees: the team's list (Admin › Paused clients), minus the
  // ones they resumed for themselves (myResumedClients - keys), plus their own
  // (myPausedClients) - General › Paused clients, or a click on a pill.
  let team = [], mine = [], resumed = [];
  let paused = []; // [{ name, key, since, note, own }]
  const norm = (list, own) => (Array.isArray(list) ? list : []).filter((p) => p && p.name).map((p) => ({ name: String(p.name), key: key(p.name), since: String(p.since || ""), note: String(p.note || ""), own })).filter((p) => p.key.length >= 3);
  function rebuild() {
    const out = norm(team, false).filter((p) => !resumed.includes(p.key));
    for (const p of norm(mine, true)) if (!out.some((x) => x.key === p.key)) out.push(p);
    paused = out;
    paint();
    paintCard();
  }
  function setList(list) { team = Array.isArray(list) ? list : []; rebuild(); }
  async function saveMine(nextMine, nextResumed) {
    mine = nextMine; resumed = nextResumed;
    try { await chrome.storage.local.set({ myPausedClients: mine, myResumedClients: resumed }); } catch (e) {}
    rebuild();
  }
  // Show a client's tasks as usual again - for this person only.
  async function resumeForMe(name) {
    const k = key(name);
    await saveMine(mine.filter((p) => key(p.name) !== k), team.some((p) => key(p.name) === k) ? resumed.concat(k).filter((x, i, a) => a.indexOf(x) === i) : resumed);
  }
  async function pauseForMe(name, note) {
    const k = key(name);
    if (k.length < 3) return false;
    const ymd = (() => { const d = new Date(); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); })();
    const onTeam = team.some((p) => key(p.name) === k);
    await saveMine(onTeam ? mine : mine.filter((p) => key(p.name) !== k).concat({ name: String(name).trim(), since: ymd, note: String(note || "").trim() }), resumed.filter((x) => x !== k));
    return true;
  }
  // The paused entry a task's client belongs to (its list name, or the client field).
  function pausedFor(t) {
    if (!t || !paused.length) return null;
    const names = [t.client, t.container && t.container.listName].filter(Boolean);
    for (const n of names) {
      const k = key(n);
      if (!k) continue;
      const hit = paused.find((p) => k === p.key || (k.length >= 4 && p.key.length >= 4 && (k.startsWith(p.key) || p.key.startsWith(k))));
      if (hit) return hit;
    }
    return null;
  }
  const since = (p) => (p.since ? " since " + new Date(p.since + "T12:00:00").toLocaleDateString([], { month: "short", day: "numeric" }) : "");
  const tip = (p) => (p.own ? "You marked " + p.name + " as paused" + since(p) : p.name + " has paused working with us" + since(p)) + (p.note ? " - " + p.note : "") + ". Don't track time on this task unless you're told to. Click to show their tasks as usual again (just for you).";
  function paintRow(row) {
    const t = row._cuTask;
    const p = pausedFor(t);
    const was = row.classList.contains("pcm-paused");
    if (!p) {
      if (was) { row.classList.remove("pcm-paused"); const pill = row.querySelector(".pcm-paused-pill"); if (pill) pill.remove(); }
      return;
    }
    row.classList.add("pcm-paused");
    row.dataset.pausedClient = p.name;
    let pill = row.querySelector(".pcm-paused-pill");
    if (!pill) {
      pill = document.createElement("span");
      pill.className = "pcm-paused-pill";
      pill.innerHTML = "<b>⏸</b><span class=\"t\"> Paused</span>"; // short: the name keeps its room (who and why on hover)
      const nm = row.querySelector(".nm");
      if (nm && nm.parentElement) nm.after(pill); else row.appendChild(pill);
    }
    // Time tracked on it anyway (e.g. from ClickUp itself) still counts - say so.
    const spent = Number(t && t.spentMs) || 0;
    const mins = Math.round(spent / 60000);
    const dur = mins >= 60 ? Math.floor(mins / 60) + "h" + (mins % 60 ? " " + (mins % 60) + "m" : "") : mins + "m";
    const label = mins >= 1 ? " Paused \u00b7 " + dur + " tracked" : " Paused";
    const tx = pill.querySelector(".t");
    if (tx && tx.textContent !== label) tx.textContent = label;
    pill.title = tip(p) + (t && !t.done ? " Its estimate isn't counted in any total while the client is paused." : "") +
      (mins >= 1 ? " " + dur + " was tracked on it anyway - that time still counts in your tracked time." : "");
  }
  let queued = false;
  function paint() {
    if (queued) return;
    queued = true;
    setTimeout(() => { // a timer, not a frame: works in a background tab too
      queued = false;
      document.querySelectorAll(".cu-task").forEach((row) => { if (row._cuTask || row.classList.contains("pcm-paused")) paintRow(row); });
    }, 40);
  }
  // A click on the pill: show this client's tasks as usual again, for you only.
  document.addEventListener("click", (e) => {
    const pill = e.target && e.target.closest && e.target.closest(".pcm-paused-pill");
    if (!pill) return;
    e.preventDefault(); e.stopPropagation();
    const row = pill.closest(".cu-task");
    const p = row && pausedFor(row._cuTask);
    if (p && confirm("Show " + p.name + "'s tasks as usual again? (Only for you - " + (p.own ? "you can pause them again" : "the team's list stays as it is") + " in General \u203A Paused clients.)")) resumeForMe(p.name);
  }, true);
  // ▶ Start on a paused client's task: ask first (captured before the row's own handler).
  document.addEventListener("click", (e) => {
    const btn = e.target && e.target.closest && e.target.closest(".cu-task .cu-iconbtn.start, .cu-task .start");
    if (!btn) return;
    const row = btn.closest(".cu-task");
    const p = row && pausedFor(row._cuTask);
    if (!p) return;
    if (!confirm("⏸ " + p.name + " has paused working with us" + since(p) + (p.note ? " (" + p.note + ")" : "") + ".\n\nTrack time on this task anyway?")) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  }, true);
  const css = document.createElement("style");
  css.textContent = `
  .cu-task.pcm-paused { opacity: .72; }
  .cu-task.pcm-paused .nm { text-decoration: line-through; text-decoration-thickness: 1.5px; color: var(--muted) !important; }
  .cu-task.pcm-paused .cu-parent { text-decoration: line-through; }
  .cu-task.pcm-paused:not(.cu-done) .est { text-decoration: line-through; opacity: .7; }
  .pcm-paused-pill { flex: none; margin-left: 4px; padding: 0 5px; border-radius: 999px; font-size: 10.5px; font-weight: 700; line-height: 1.6; white-space: nowrap;
    color: #92400e; background: rgba(245, 158, 11, .16); border: 1px solid rgba(245, 158, 11, .45); cursor: help; text-decoration: none; }
  .pcm-paused-pill b { font-weight: 700; }
  .pcm-paused-pill { cursor: pointer; }
  .my-pause-item { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 6px 0; border-top: 1px solid var(--border); }
  .my-pause-item:first-child { border-top: 0; }
  .my-pause-item .w { flex: 1 1 220px; min-width: 0; }
  .my-pause-item.off .w { opacity: .7; }
  @container cutl (max-width: 560px) { .pcm-paused-pill .t { display: none; } }
  html[data-theme="dark"] .pcm-paused-pill { color: #fbbf24; background: rgba(245, 158, 11, .14); }`;
  (document.head || document.documentElement).appendChild(css);
  const mo = new MutationObserver(paint);
  const start = () => { mo.observe(document.body, { childList: true, subtree: true }); paint(); };
  if (document.body) start(); else document.addEventListener("DOMContentLoaded", start, { once: true });
  try {
    chrome.storage.local.get(["pausedClients", "myPausedClients", "myResumedClients"]).then((g) => {
      team = (g && g.pausedClients) || []; mine = Array.isArray(g && g.myPausedClients) ? g.myPausedClients : []; resumed = Array.isArray(g && g.myResumedClients) ? g.myResumedClients : [];
      rebuild();
    }).catch(() => {});
    chrome.storage.onChanged.addListener((ch, area) => {
      if (area !== "local" || !(ch.pausedClients || ch.myPausedClients || ch.myResumedClients)) return;
      if (ch.pausedClients) team = ch.pausedClients.newValue || [];
      if (ch.myPausedClients) mine = ch.myPausedClients.newValue || [];
      if (ch.myResumedClients) resumed = ch.myResumedClients.newValue || [];
      rebuild();
    });
  } catch (e) {}
  // ---------- General › Paused clients (each person's own card) ----------
  const esc = (s) => String(s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  function paintCard() {
    const box = document.getElementById("myPauseList");
    if (!box) return;
    const sinceTxt = (p) => (p.since ? ' <span class="hint">since ' + esc(new Date(p.since + "T12:00:00").toLocaleDateString([], { month: "short", day: "numeric" })) + "</span>" : "");
    const teamRows = norm(team, false).map((p) => {
      const off = resumed.includes(p.key);
      return '<div class="my-pause-item' + (off ? " off" : "") + '"><span class="w">' + (off ? "\u25B6 " : "\u23F8 ") + "<b>" + esc(p.name) + "</b>" + sinceTxt(p) + (p.note ? ' <span class="hint">- ' + esc(p.note) + "</span>" : "") +
        ' <span class="hint">(team' + (off ? " - you show their tasks as usual" : "") + ")</span></span>" +
        (off ? '<button type="button" data-my-repause="' + esc(p.name) + '">Pause again</button>' : '<button type="button" data-my-resume="' + esc(p.name) + '" title="Show their tasks as usual again - just for you">Resume for me</button>') + "</div>";
    });
    const mineRows = norm(mine, true).map((p) => '<div class="my-pause-item"><span class="w">\u23F8 <b>' + esc(p.name) + "</b>" + sinceTxt(p) + (p.note ? ' <span class="hint">- ' + esc(p.note) + "</span>" : "") + ' <span class="hint">(yours)</span></span><button type="button" data-my-resume="' + esc(p.name) + '">Resume</button></div>');
    box.innerHTML = teamRows.concat(mineRows).join("") || '<span class="hint">No paused clients - every task shows as usual.</span>';
  }
  function wireCard() {
    const card = document.getElementById("myPauseCard");
    if (!card || card._wired) return;
    card._wired = true;
    const name = document.getElementById("myPauseName"), note = document.getElementById("myPauseNote"), msg = document.getElementById("myPauseMsg");
    const say = (t) => { if (msg) msg.textContent = t; };
    document.getElementById("myPauseAdd").onclick = async () => {
      const n = name.value.trim();
      if (!n) { say("Type the client's name first."); return; }
      if (paused.some((p) => p.key === key(n))) { say(n + " is already paused."); return; }
      await pauseForMe(n, note.value);
      name.value = ""; note.value = "";
      say("Paused " + n + " \u2713 Their tasks are struck through and left out of your totals (only on this computer).");
    };
    card.addEventListener("click", async (e) => {
      const r = e.target.closest("[data-my-resume]"), a = e.target.closest("[data-my-repause]");
      if (r) { await resumeForMe(r.dataset.myResume); say("Resumed " + r.dataset.myResume + " \u2713 Their tasks show as usual again for you."); }
      if (a) { await pauseForMe(a.dataset.myRepause); say("Paused " + a.dataset.myRepause + " again \u2713"); }
    });
    // Suggestions: every client in the workspace (asked once, when the box is used).
    name.addEventListener("focus", () => {
      try { chrome.runtime.sendMessage({ type: "CLICKUP_CLIENT_NAMES" }, (res) => { void chrome.runtime.lastError; const dl = document.getElementById("myPauseNames"); if (dl && res && Array.isArray(res.names)) dl.innerHTML = res.names.map((x) => '<option value="' + esc(x) + '"></option>').join(""); }); } catch (e) {}
    }, { once: true });
    paintCard();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", wireCard); else wireCard();
  window.PcmPaused = { key, pausedFor, get list() { return paused.slice(); }, setList, pauseForMe, resumeForMe };
})();
