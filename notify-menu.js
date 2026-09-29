// Notification bell, shared by the popup, the side panel and the options page.
// Sits next to the dark/light button and opens a small menu: mute everything,
// pause for a while (30 min, 1 or 2 hours, until tomorrow morning or until a
// time you pick), and one toggle per reminder type. Writes the same
// settings the Options page uses (via SET_SETTINGS), so both always agree.
// The background checks notifyAll / notifyPausedUntil in notify().
(function () {
  const TYPES = [
    ["clickupIdleNotify", "Not tracking reminder", "No timer running during office hours"],
    ["clickupAwayNotify", "Away time question", "Remove time a timer ran while you were away"],
    ["clickupNotify", "Daily target progress", "Halfway, almost there, target reached, behind"],
    ["clickupRunningNotify", "Estimate almost up", "A running task nears its estimate"],
    ["clickupWrapUp", "End-of-day wrap-up", "Weekday reminder to wrap up"],
    ["notifySound", "Sound", "Chime with each notification"],
  ];
  let settings = {};
  let menu = null;

  const css = document.createElement("style");
  css.textContent = `
    .nm-bell { border: none; background: none; cursor: pointer; font-size: 14px; padding: 2px 4px; line-height: 1; color: var(--text); }
    .nm-menu { position: fixed; z-index: 1000; width: 270px; background: var(--card); color: var(--text); border: 1px solid var(--border);
      border-radius: 10px; box-shadow: 0 12px 28px rgba(0,0,0,.2); padding: 8px; font-size: 12.5px; }
    .nm-menu h4 { margin: 2px 4px 8px; font-size: 12px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); }
    .nm-row { display: flex; align-items: center; gap: 8px; padding: 6px 4px; border-radius: 7px; cursor: pointer; }
    .nm-row:hover { background: var(--bg2); }
    .nm-row .nm-t { flex: 1; min-width: 0; }
    .nm-row .nm-t small { display: block; color: var(--muted); font-size: 11px; }
    .nm-row.off .nm-t { opacity: .5; }
    .nm-sw { flex: none; width: 30px; height: 17px; border-radius: 99px; background: var(--border); position: relative; transition: background .15s; }
    .nm-sw::after { content: ""; position: absolute; top: 2px; left: 2px; width: 13px; height: 13px; border-radius: 50%; background: #fff; transition: left .15s; box-shadow: 0 1px 2px rgba(0,0,0,.3); }
    .nm-sw.on { background: var(--indigo); }
    .nm-sw.on::after { left: 15px; }
    .nm-pause { display: flex; align-items: center; gap: 8px; margin: 4px 4px 8px; flex-wrap: wrap; }
    .nm-chips { display: flex; flex-wrap: wrap; gap: 5px; margin: 0 4px 8px; }
    .nm-chips button { font: inherit; font-size: 11.5px; padding: 3px 9px; border-radius: 99px; border: 1px solid var(--border); background: var(--bg2); color: var(--text); cursor: pointer; }
    .nm-chips button:hover { border-color: var(--indigo); }
    .nm-until { display: flex; align-items: center; gap: 6px; margin: 0 4px 8px; font-size: 11.5px; color: var(--muted); }
    .nm-until input { font: inherit; font-size: 12px; padding: 2px 4px; border: 1px solid var(--border); border-radius: 6px; background: var(--bg2); color: var(--text); color-scheme: light dark; }
    .nm-until button { font: inherit; font-size: 11.5px; font-weight: 600; padding: 3px 9px; border-radius: 7px; border: 1px solid var(--indigo); background: var(--indigo); color: #fff; cursor: pointer; }
    .nm-pause span { flex: 1; color: var(--muted); font-size: 11.5px; }
    .nm-pause button { font: inherit; font-size: 11.5px; font-weight: 600; padding: 4px 10px; border-radius: 7px; border: 1px solid var(--border); background: var(--bg2); color: var(--text); cursor: pointer; }
    .nm-sep { height: 1px; background: var(--border); margin: 4px 0; }
    .nm-vol { display: flex; align-items: center; gap: 8px; padding: 2px 4px 6px; }
    .nm-vol input { flex: 1; min-width: 0; accent-color: var(--indigo); }
    .nm-vol span { font-size: 11px; color: var(--muted); min-width: 34px; text-align: right; }
  `;
  document.head.appendChild(css);

  const pausedUntil = () => Number(settings.notifyPausedUntil) || 0;
  const isPaused = () => pausedUntil() > Date.now();
  const allOn = () => settings.notifyAll !== false;
  const on = (k) => settings[k] !== false;
  const save = (patch) => { chrome.runtime.sendMessage({ type: "SET_SETTINGS", patch }).catch(() => {}); };
  // "3:30 PM" today, "Tue 9:00 AM" on another day.
  const untilLabel = (ms) => {
    const d = new Date(ms), t = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    return d.toDateString() === new Date().toDateString() ? t : d.toLocaleDateString([], { weekday: "short" }) + " " + t;
  };
  // Office start hour (Options > ClickUp setup), 8:00 if not set.
  const startHour = () => { const h = Number(settings.clickupIdleStartHour); return Number.isFinite(h) && h >= 0 && h < 24 ? h : 8; };
  // The next workday morning: tomorrow, or Monday on a Friday / weekend.
  const nextWorkStart = () => { const d = new Date(); d.setDate(d.getDate() + 1); while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1); d.setHours(startHour(), 0, 0, 0); return d.getTime(); };

  function paintBell(bell) {
    const muted = !allOn() || isPaused();
    bell.textContent = muted ? "🔕" : "🔔";
    bell.title = !allOn() ? "Notifications are off"
      : isPaused() ? "Notifications paused until " + untilLabel(pausedUntil())
      : "Notifications";
  }

  function row(label, hint, isOn, dim, onClick) {
    const r = document.createElement("div");
    r.className = "nm-row" + (dim ? " off" : "");
    r.innerHTML = '<div class="nm-t"></div><div class="nm-sw"></div>';
    r.firstChild.textContent = label;
    if (hint) { const s = document.createElement("small"); s.textContent = hint; r.firstChild.appendChild(s); }
    r.lastChild.classList.toggle("on", isOn);
    r.onclick = onClick;
    return r;
  }

  function renderMenu() {
    if (!menu) return;
    menu.innerHTML = "<h4>Notifications</h4>";
    menu.appendChild(row("All notifications", "", allOn(), false, () => save({ notifyAll: !allOn() })));
    const p = document.createElement("div");
    p.className = "nm-pause";
    const txt = document.createElement("span");
    const btn = document.createElement("button");
    const extra = [];
    if (isPaused()) {
      txt.textContent = "Paused until " + untilLabel(pausedUntil());
      btn.textContent = "Resume";
      btn.onclick = () => save({ notifyPausedUntil: 0 });
      p.append(txt, btn);
    } else {
      // Do not disturb: pick how long. Your own reminders still show.
      txt.textContent = "Pause for (lunch, a meeting, focus time):";
      txt.title = "Your own reminders still show while paused.";
      p.append(txt);
      const chips = document.createElement("div");
      chips.className = "nm-chips";
      const h = startHour();
      const nw = new Date(nextWorkStart()), tmr = new Date(); tmr.setDate(tmr.getDate() + 1);
      const day = nw.toDateString() === tmr.toDateString() ? "tomorrow" : nw.toLocaleDateString([], { weekday: "long" });
      for (const [label, ms] of [["30 min", () => Date.now() + 30 * 60000], ["1 hour", () => Date.now() + 60 * 60000], ["2 hours", () => Date.now() + 120 * 60000],
        ["Until " + day + " " + (h > 12 ? h - 12 : h || 12) + (h < 12 ? " AM" : " PM"), nextWorkStart]]) {
        const c = document.createElement("button");
        c.type = "button"; c.textContent = label;
        c.onclick = () => save({ notifyPausedUntil: ms() });
        chips.appendChild(c);
      }
      // Custom: until a time you pick (a time that has passed today = tomorrow).
      const u = document.createElement("div");
      u.className = "nm-until";
      u.innerHTML = '<span>Until</span><input type="time" /><button type="button">Pause</button>';
      const tin = u.querySelector("input"), go = u.querySelector("button");
      const def = new Date(Date.now() + 90 * 60000); def.setMinutes(Math.ceil(def.getMinutes() / 15) * 15, 0, 0);
      tin.value = String(def.getHours()).padStart(2, "0") + ":" + String(def.getMinutes()).padStart(2, "0");
      go.onclick = () => {
        const m = /^(\d{1,2}):(\d{2})$/.exec(tin.value || "");
        if (!m) { tin.focus(); return; }
        const d = new Date(); d.setHours(Number(m[1]), Number(m[2]), 0, 0);
        if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
        save({ notifyPausedUntil: d.getTime() });
      };
      tin.onkeydown = (e) => { if (e.key === "Enter") go.onclick(); };
      extra.push(chips, u);
    }
    if (allOn()) { menu.appendChild(p); for (const x of extra) menu.appendChild(x); }
    menu.appendChild(Object.assign(document.createElement("div"), { className: "nm-sep" }));
    for (const [key, label, hint] of TYPES) {
      menu.appendChild(row(label, hint, on(key), !allOn(), () => save({ [key]: !on(key) })));
      if (key === "notifySound" && on(key) && allOn()) {
        // Loudness of every notification sound; letting go plays a sample.
        const v = document.createElement("div");
        v.className = "nm-vol";
        v.title = "Notification volume (100% = your computer's normal volume)";
        const cur = Number(settings.notifyVolume) > 0 ? Number(settings.notifyVolume) : 100;
        v.innerHTML = '<small style="color:var(--muted)">Volume</small><input type="range" min="5" max="100" step="5" /><span></span>';
        const r = v.querySelector("input"), s = v.querySelector("span");
        r.value = String(cur); s.textContent = cur + "%";
        r.oninput = () => { s.textContent = r.value + "%"; };
        r.onchange = () => {
          settings.notifyVolume = Number(r.value);
          save({ notifyVolume: Number(r.value) });
          chrome.runtime.sendMessage({ type: "PLAY_TEST_SOUND", volume: Number(r.value) }).catch(() => {});
        };
        menu.appendChild(v);
      }
    }
  }

  function place(bell) {
    const r = bell.getBoundingClientRect();
    const w = 270;
    menu.style.top = Math.round(r.bottom + 6) + "px";
    menu.style.left = Math.round(Math.max(8, Math.min(window.innerWidth - w - 8, r.right - w))) + "px";
  }

  function init() {
    const theme = document.getElementById("themeToggle");
    if (!theme || document.getElementById("notifyBell")) return;
    const bell = document.createElement("button");
    bell.id = "notifyBell";
    bell.type = "button";
    bell.className = "nm-bell";
    const wrap = document.createElement("span");
    wrap.style.cssText = "display:inline-flex;align-items:center;gap:6px;flex:none;margin-left:auto;";
    theme.parentNode.insertBefore(wrap, theme);
    wrap.append(bell, theme);

    bell.onclick = (e) => {
      e.stopPropagation();
      if (menu) { menu.remove(); menu = null; return; }
      menu = document.createElement("div");
      menu.className = "nm-menu";
      menu.onclick = (ev) => ev.stopPropagation();
      document.body.appendChild(menu);
      renderMenu();
      place(bell);
    };
    document.addEventListener("click", () => { if (menu) { menu.remove(); menu = null; } });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && menu) { menu.remove(); menu = null; } });

    const load = (s) => { settings = s && typeof s === "object" ? s : {}; paintBell(bell); renderMenu(); };
    chrome.storage.local.get("settings").then(({ settings: s }) => load(s)).catch(() => load({}));
    chrome.storage.onChanged.addListener((ch, area) => { if (area === "local" && ch.settings) load(ch.settings.newValue); });
    // The pause ends on its own; repaint the icon when it does.
    setInterval(() => paintBell(bell), 30000);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
