// Notification bell, shared by the popup, the side panel and the options page.
// Sits next to the dark/light button and opens a small menu: mute everything,
// pause for an hour (lunch), and one toggle per reminder type. Writes the same
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
  const PAUSE_MS = 60 * 60000;
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
    .nm-pause { display: flex; align-items: center; gap: 8px; margin: 4px 4px 8px; }
    .nm-pause span { flex: 1; color: var(--muted); font-size: 11.5px; }
    .nm-pause button { font: inherit; font-size: 11.5px; font-weight: 600; padding: 4px 10px; border-radius: 7px; border: 1px solid var(--border); background: var(--bg2); color: var(--text); cursor: pointer; }
    .nm-sep { height: 1px; background: var(--border); margin: 4px 0; }
  `;
  document.head.appendChild(css);

  const pausedUntil = () => Number(settings.notifyPausedUntil) || 0;
  const isPaused = () => pausedUntil() > Date.now();
  const allOn = () => settings.notifyAll !== false;
  const on = (k) => settings[k] !== false;
  const save = (patch) => { chrome.runtime.sendMessage({ type: "SET_SETTINGS", patch }).catch(() => {}); };

  function paintBell(bell) {
    const muted = !allOn() || isPaused();
    bell.textContent = muted ? "🔕" : "🔔";
    bell.title = !allOn() ? "Notifications are off"
      : isPaused() ? "Notifications paused until " + new Date(pausedUntil()).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
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
    if (isPaused()) {
      txt.textContent = "Paused until " + new Date(pausedUntil()).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
      btn.textContent = "Resume";
      btn.onclick = () => save({ notifyPausedUntil: 0 });
    } else {
      txt.textContent = "Going for lunch or a meeting?";
      btn.textContent = "Pause 1 hour";
      btn.onclick = () => save({ notifyPausedUntil: Date.now() + PAUSE_MS });
    }
    p.append(txt, btn);
    if (allOn()) menu.appendChild(p);
    menu.appendChild(Object.assign(document.createElement("div"), { className: "nm-sep" }));
    for (const [key, label, hint] of TYPES) {
      menu.appendChild(row(label, hint, on(key), !allOn(), () => save({ [key]: !on(key) })));
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
    wrap.style.cssText = "display:inline-flex;align-items:center;gap:4px;flex:none;";
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
