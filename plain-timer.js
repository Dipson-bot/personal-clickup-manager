// ⏱ Timer in the top bar of the popup, the side panel (which uses the popup) and the Options page:
// a plain stopwatch and a countdown, not connected to tasks or ClickUp.
// The state is kept in storage ("plainTimer") as times on the clock, not as a
// ticking number, so it keeps going with the popup closed and is right when it
// opens again. A countdown's end is rung by the background (alarm "plain-timer":
// the chime + a notification), even with the popup closed.
(() => {
  "use strict";
  // The popup / side panel has #plainTimerBtn, the Options page #optPlainTimerBtn;
  // both share the same timer (storage), so one started in either shows in both.
  const btn = document.getElementById("plainTimerBtn") || document.getElementById("optPlainTimerBtn");
  if (!btn) return;
  const KEY = "plainTimer";
  const PRESETS = [5, 10, 15, 25, 45, 60];
  const fresh = () => ({ tab: "sw", sw: { running: false, startedAt: 0, accMs: 0, laps: [] }, cd: { running: false, endAt: 0, remainingMs: 25 * 60000, durMs: 25 * 60000, done: false } });
  let st = fresh();
  let open = false, tick = 0;

  const pad = (n) => String(n).padStart(2, "0");
  const fmt = (ms, tenths) => {
    ms = Math.max(0, ms);
    const t = Math.floor(ms / 1000), h = Math.floor(t / 3600), m = Math.floor(t / 60) % 60, s = t % 60;
    return (h ? h + ":" + pad(m) : m) + ":" + pad(s) + (tenths ? "." + Math.floor((ms % 1000) / 100) : "");
  };
  const swNow = () => st.sw.accMs + (st.sw.running ? Date.now() - st.sw.startedAt : 0);
  const cdLeft = () => (st.cd.running ? st.cd.endAt - Date.now() : st.cd.remainingMs);
  const save = () => { try { chrome.storage.local.set({ [KEY]: st }); } catch (e) {} };
  const send = (msg) => { try { chrome.runtime.sendMessage(msg, () => void chrome.runtime.lastError); } catch (e) {} };
  // Minutes typed as "25", "1h", "1h 30m", "90m", "45s".
  function parseDur(s) {
    s = String(s || "").trim().toLowerCase();
    if (/^\d+(\.\d+)?$/.test(s)) return Math.round(parseFloat(s) * 60000);
    let ms = 0, any = false;
    s.replace(/(\d+(?:\.\d+)?)\s*(h|m|s)/g, (_, n, u) => { any = true; ms += parseFloat(n) * (u === "h" ? 3600000 : u === "m" ? 60000 : 1000); return ""; });
    return any ? Math.round(ms) : 0;
  }

  // ---------- the label next to the icon ----------
  const lbl = document.createElement("span");
  lbl.className = "pt-lbl";
  lbl.hidden = true;
  btn.after(lbl);
  lbl.onclick = () => toggle();

  // ---------- the panel ----------
  const css = document.createElement("style");
  css.textContent = `
  .pt-lbl { font: 600 11px/1 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-variant-numeric: tabular-nums; padding: 5px 7px; border-radius: 7px; border: 1px solid var(--border); background: var(--card); color: var(--indigo, #6366f1); cursor: pointer; white-space: nowrap; }
  .pt-lbl.cd { color: #d97706; }
  .pt-lbl.done { color: #fff; background: #dc2626; border-color: #dc2626; }
  .pt-panel { position: fixed; z-index: 9999; width: 280px; background: var(--card); color: var(--text); border: 1px solid var(--border); border-radius: 12px; box-shadow: 0 12px 32px rgba(0,0,0,.22); padding: 12px; font-size: 13px; }
  .pt-tabs { display: flex; gap: 4px; margin: 0 0 10px; background: var(--bg2, rgba(0,0,0,.05)); border-radius: 8px; padding: 3px; }
  .pt-tabs button { flex: 1; font: inherit; font-size: 12px; font-weight: 600; padding: 5px 0; border: 0; border-radius: 6px; background: none; color: var(--muted); cursor: pointer; }
  .pt-tabs button.on { background: var(--card); color: var(--text); box-shadow: 0 1px 2px rgba(0,0,0,.12); }
  .pt-big { font: 700 34px/1.1 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-variant-numeric: tabular-nums; text-align: center; margin: 4px 0 10px; letter-spacing: -.5px; }
  .pt-big.done { color: #dc2626; }
  .pt-row { display: flex; gap: 6px; justify-content: center; flex-wrap: wrap; }
  .pt-row button { font: inherit; font-size: 12px; font-weight: 600; padding: 6px 12px; border-radius: 8px; border: 1px solid var(--border); background: var(--card); color: var(--text); cursor: pointer; }
  .pt-row button.main { background: var(--indigo, #6366f1); border-color: var(--indigo, #6366f1); color: #fff; }
  .pt-row button:disabled { opacity: .45; cursor: default; }
  .pt-pre { display: flex; gap: 4px; flex-wrap: wrap; justify-content: center; margin: 0 0 8px; }
  .pt-pre button { font: inherit; font-size: 11.5px; padding: 3px 8px; border-radius: 999px; border: 1px solid var(--border); background: var(--card); color: var(--text); cursor: pointer; }
  .pt-pre button.on { border-color: var(--indigo, #6366f1); color: var(--indigo, #6366f1); }
  .pt-pre input { width: 70px; font: inherit; font-size: 11.5px; padding: 3px 6px; border-radius: 999px; border: 1px solid var(--border); background: var(--card); color: var(--text); text-align: center; }
  .pt-laps { margin: 10px 0 0; max-height: 120px; overflow: auto; font: 12px/1.6 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-variant-numeric: tabular-nums; }
  .pt-laps div { display: flex; justify-content: space-between; border-top: 1px solid var(--border); padding: 2px 2px; color: var(--muted); }
  .pt-laps div b { color: var(--text); font-weight: 600; }
  .pt-note { font-size: 11px; color: var(--muted); text-align: center; margin-top: 8px; }
  `;
  document.head.appendChild(css);
  const panel = document.createElement("div");
  panel.className = "pt-panel";
  panel.hidden = true;
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", "Timer");
  document.body.appendChild(panel);

  function place() {
    const r = btn.getBoundingClientRect();
    const w = 280;
    panel.style.top = Math.round(r.bottom + 6) + "px";
    panel.style.left = Math.round(Math.max(8, Math.min(window.innerWidth - w - 8, r.right - w))) + "px";
  }
  function toggle(force) {
    open = typeof force === "boolean" ? force : !open;
    panel.hidden = !open;
    if (open) { place(); paint(); }
    run();
  }
  btn.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); toggle(); });
  // A click outside closes it. A button inside redraws the panel first, so its old
  // element is gone by now - that isn't an outside click.
  document.addEventListener("click", (e) => { if (open && e.target && e.target.isConnected && !panel.contains(e.target) && e.target !== btn && e.target !== lbl) toggle(false); });
  document.addEventListener("keydown", (e) => { if (open && e.key === "Escape") toggle(false); });
  window.addEventListener("resize", () => { if (open) place(); });

  function paint() {
    // The label: whatever is running (the countdown first), or a finished countdown.
    const cdOn = st.cd.running || st.cd.done;
    if (st.cd.running) { lbl.textContent = fmt(cdLeft()); lbl.className = "pt-lbl cd"; lbl.hidden = false; lbl.title = "Countdown - click to open"; }
    else if (st.cd.done) { lbl.textContent = "0:00"; lbl.className = "pt-lbl done"; lbl.hidden = false; lbl.title = "Countdown finished - click to open"; }
    else if (st.sw.running || st.sw.accMs) { lbl.textContent = fmt(swNow()); lbl.className = "pt-lbl"; lbl.hidden = false; lbl.title = st.sw.running ? "Stopwatch - click to open" : "Stopwatch (paused) - click to open"; }
    else lbl.hidden = true;
    void cdOn;
    if (!open) return;
    const sw = st.tab === "sw";
    let h = '<div class="pt-tabs"><button type="button" data-tab="sw" class="' + (sw ? "on" : "") + '">Stopwatch</button><button type="button" data-tab="cd" class="' + (!sw ? "on" : "") + '">Countdown</button></div>';
    if (sw) {
      h += '<div class="pt-big">' + fmt(swNow(), true) + "</div>" +
        '<div class="pt-row"><button type="button" class="main" data-a="sw-go">' + (st.sw.running ? "Pause" : st.sw.accMs ? "Resume" : "Start") + "</button>" +
        '<button type="button" data-a="sw-lap"' + (st.sw.running ? "" : " disabled") + ">Lap</button>" +
        '<button type="button" data-a="sw-reset"' + (st.sw.running || st.sw.accMs ? "" : " disabled") + ">Reset</button></div>";
      if (st.sw.laps.length) {
        let prev = 0;
        const rows = st.sw.laps.map((t, i) => { const d = t - prev; prev = t; return '<div><span>Lap ' + (i + 1) + "</span><span>+" + fmt(d, true) + " · <b>" + fmt(t, true) + "</b></span></div>"; }).reverse();
        h += '<div class="pt-laps">' + rows.join("") + "</div>";
      }
    } else {
      const left = cdLeft();
      const idle = !st.cd.running && !st.cd.done && st.cd.remainingMs === st.cd.durMs;
      h += '<div class="pt-pre">' + PRESETS.map((m) => '<button type="button" data-min="' + m + '" class="' + (st.cd.durMs === m * 60000 ? "on" : "") + '"' + (st.cd.running ? " disabled" : "") + ">" + (m >= 60 ? m / 60 + "h" : m + "m") + "</button>").join("") +
        '<input type="text" id="ptCustom" placeholder="e.g. 1h 30m" title="Type a time: 20, 1h, 1h 30m, 90m, 45s - then Enter"' + (st.cd.running ? " disabled" : "") + "></div>" +
        '<div class="pt-big' + (st.cd.done ? " done" : "") + '">' + (st.cd.done ? "Time's up" : fmt(left)) + "</div>" +
        '<div class="pt-row"><button type="button" class="main" data-a="cd-go">' + (st.cd.running ? "Pause" : st.cd.done ? "Again" : idle ? "Start" : "Resume") + "</button>" +
        '<button type="button" data-a="cd-reset"' + (idle ? " disabled" : "") + ">Reset</button></div>" +
        '<div class="pt-note">Rings and notifies when it ends, even with this closed.</div>';
    }
    panel.innerHTML = h;
    panel.querySelectorAll("[data-tab]").forEach((b) => { b.onclick = () => { st.tab = b.getAttribute("data-tab"); save(); paint(); }; });
    panel.querySelectorAll("[data-a]").forEach((b) => { b.onclick = () => act(b.getAttribute("data-a")); });
    panel.querySelectorAll("[data-min]").forEach((b) => { b.onclick = () => setDur(Number(b.getAttribute("data-min")) * 60000); });
    const c = panel.querySelector("#ptCustom");
    if (c) c.onkeydown = (e) => { if (e.key === "Enter") { const ms = parseDur(c.value); if (ms >= 1000) setDur(Math.min(ms, 24 * 3600000)); else c.value = ""; } };
  }
  function setDur(ms) {
    st.cd = { running: false, endAt: 0, remainingMs: ms, durMs: ms, done: false };
    send({ type: "PLAIN_TIMER_ALARM", endAt: 0 });
    save(); paint();
  }
  function act(a) {
    const now = Date.now();
    if (a === "sw-go") {
      if (st.sw.running) { st.sw.accMs += now - st.sw.startedAt; st.sw.running = false; }
      else { st.sw.startedAt = now; st.sw.running = true; }
    } else if (a === "sw-lap" && st.sw.running) st.sw.laps.push(swNow());
    else if (a === "sw-reset") st.sw = { running: false, startedAt: 0, accMs: 0, laps: [] };
    else if (a === "cd-go") {
      if (st.cd.running) { st.cd.remainingMs = Math.max(0, st.cd.endAt - now); st.cd.running = false; send({ type: "PLAIN_TIMER_ALARM", endAt: 0 }); }
      else {
        if (st.cd.done || st.cd.remainingMs <= 0) { st.cd.remainingMs = st.cd.durMs; st.cd.done = false; }
        st.cd.endAt = now + st.cd.remainingMs; st.cd.running = true;
        send({ type: "PLAIN_TIMER_ALARM", endAt: st.cd.endAt, durMs: st.cd.durMs });
      }
    } else if (a === "cd-reset") { st.cd = { running: false, endAt: 0, remainingMs: st.cd.durMs, durMs: st.cd.durMs, done: false }; send({ type: "PLAIN_TIMER_ALARM", endAt: 0 }); }
    save(); paint(); run();
  }
  // Repaint while something runs: 10 a second with the panel open, once a second for the label.
  function run() {
    clearInterval(tick); tick = 0;
    const live = st.sw.running || st.cd.running;
    if (!live) return;
    tick = setInterval(() => {
      if (st.cd.running && cdLeft() <= 0) { st.cd = Object.assign({}, st.cd, { running: false, remainingMs: 0, done: true }); save(); run(); } // the background rings
      paint();
    }, open ? 100 : 1000);
  }
  // Load, and follow changes made in another window (popup and side panel together).
  chrome.storage.local.get(KEY).then((g) => {
    const v = g && g[KEY];
    if (v && v.sw && v.cd) st = Object.assign(fresh(), v);
    paint(); run();
  }).catch(() => {});
  chrome.storage.onChanged.addListener((ch, area) => {
    if (area !== "local" || !ch[KEY] || !ch[KEY].newValue) return;
    const v = ch[KEY].newValue;
    if (JSON.stringify(v) === JSON.stringify(st)) return;
    st = Object.assign(fresh(), v);
    paint(); run();
  });
})();
