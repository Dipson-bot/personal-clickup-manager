// One calm, consistent toolbar for the top of the popup, side panel and the
// options page. The header buttons are created by several scripts (search,
// reminders, notifications, theme) and some of them rewrite their own text
// (🔔/🔕, 🌙 Dark/☀️ Light), so this never replaces their content: it adds a
// class, hides the emoji/text with CSS and draws a matching line icon through a
// CSS mask (so it follows the theme colour). What each button does is untouched.
(() => {
  "use strict";
  const svg = (paths) => "url(\"data:image/svg+xml;utf8," + encodeURIComponent(
    "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'>" + paths + "</svg>") + "\")";
  const ICONS = {
    search: svg("<circle cx='11' cy='11' r='7'/><path d='M20.5 20.5 16 16'/>"),
    panel: svg("<rect x='3' y='4' width='18' height='16' rx='2.5'/><path d='M15 4v16'/>"),
    side: svg("<path d='M4 8h15M15 4l4 4-4 4M20 16H5M9 12l-4 4 4 4'/>"),
    wrap: svg("<rect x='5' y='4' width='14' height='17' rx='2'/><path d='M9 3h6v3H9z'/><path d='M9 13l2 2 4-4'/>"),
    alarm: svg("<circle cx='12' cy='13' r='7'/><path d='M12 10v3l2 2M5 4 2.5 6.5M19 4l2.5 2.5'/>"),
    bell: svg("<path d='M6 9a6 6 0 0 1 12 0c0 6 2.5 8 2.5 8h-17S6 15 6 9'/><path d='M10.3 20a2 2 0 0 0 3.4 0'/>"),
    bellOff: svg("<path d='M6 9a6 6 0 0 1 12 0c0 6 2.5 8 2.5 8h-17S6 15 6 9'/><path d='M10.3 20a2 2 0 0 0 3.4 0M3 3l18 18'/>"),
    moon: svg("<path d='M20 13.5A8 8 0 1 1 10.5 4a6.3 6.3 0 0 0 9.5 9.5z'/>"),
    sun: svg("<circle cx='12' cy='12' r='4'/><path d='M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4'/>"),
    dash: svg("<rect x='3' y='3' width='7' height='7' rx='1.5'/><rect x='14' y='3' width='7' height='7' rx='1.5'/><rect x='14' y='14' width='7' height='7' rx='1.5'/><rect x='3' y='14' width='7' height='7' rx='1.5'/>"),
  };
  const isPopup = !!document.querySelector(".header .header-actions");
  const size = isPopup ? 28 : 34;
  const css = document.createElement("style");
  css.textContent = `
  .pcm-ib { width: ${size}px !important; height: ${size}px !important; min-width: ${size}px; padding: 0 !important; margin: 0 !important; display: inline-flex !important; align-items: center; justify-content: center;
    border: 1px solid var(--border) !important; border-radius: ${isPopup ? 8 : 10}px !important; background: var(--card) !important; color: var(--muted) !important;
    font-size: 0 !important; line-height: 0 !important; position: relative; cursor: pointer; flex: none; box-shadow: none !important; text-decoration: none !important; gap: 0 !important; }
  .pcm-ib:hover, .pcm-ib:focus-visible { color: var(--text) !important; border-color: var(--indigo, #6366f1) !important; }
  .pcm-ib::before { content: ""; width: ${isPopup ? 15 : 17}px; height: ${isPopup ? 15 : 17}px; background: currentColor; -webkit-mask: var(--ico) center / contain no-repeat; mask: var(--ico) center / contain no-repeat; }
  .pcm-ib > svg { display: none !important; }
  .pcm-ib .rm-n { position: absolute; top: -5px; right: -5px; font: 700 9px/14px system-ui, sans-serif !important; }
  .pcm-ib.muted { color: var(--amber, #d97706) !important; }
  .pcm-ib[data-ico="moon"] { --ico: ${ICONS.moon}; }
  html[data-theme="dark"] .pcm-ib[data-ico="moon"] { --ico: ${ICONS.sun}; }
  ${Object.keys(ICONS).filter((k) => k !== "moon").map((k) => `.pcm-ib[data-ico="${k}"] { --ico: ${ICONS[k]}; }`).join("\n  ")}
  .pcm-ib.muted[data-ico="bell"] { --ico: ${ICONS.bellOff}; }
  .header-actions, .hdr-tools { gap: ${isPopup ? 4 : 6}px !important; }
  .header-actions > span, .hdr-tools > span { gap: ${isPopup ? 4 : 6}px !important; }
  ${isPopup ? `.header h1 { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .header .header-actions { flex: none; }` : ""}
  `;
  document.head.appendChild(css);

  // id -> [icon, label shown on hover / read by screen readers]
  const MAP = {
    panelBtn: ["panel", "Open in the side panel"], optPanelBtn: ["panel", "Open in the side panel"],
    sideBtn: ["side", "Show the side panel on the left or right"],
    wrapBtn: ["wrap", "Wrap up the day"], optWrapBtn: ["wrap", "Wrap up the day"],
    remBtn: ["alarm", ""], notifyBell: ["bell", ""],
    themeToggle: ["moon", "Switch light / dark"],
    manage: ["dash", "Open the dashboard (all settings)"],
  };
  function dress(b, ico, label) {
    if (!b || b.classList.contains("pcm-ib")) return;
    b.classList.add("pcm-ib");
    b.dataset.ico = ico;
    if (label) { if (!b.title) b.title = label; b.setAttribute("aria-label", label); }
    if (ico === "bell") {
      const sync = () => { b.classList.toggle("muted", /🔕/.test(b.textContent)); if (!b.getAttribute("aria-label")) b.setAttribute("aria-label", "Notifications"); };
      sync();
      new MutationObserver(sync).observe(b, { childList: true, characterData: true, subtree: true });
    }
    if (ico === "alarm" && !b.getAttribute("aria-label")) b.setAttribute("aria-label", "Reminders");
  }
  function apply() {
    for (const [id, [ico, label]] of Object.entries(MAP)) dress(document.getElementById(id), ico, label);
    // The popup's search button has no id (pcm-search.js): the first 🔍 in the header.
    const acts = document.querySelector(".header .header-actions");
    if (acts) for (const b of acts.querySelectorAll("button")) if (!b.classList.contains("pcm-ib") && /🔍/.test(b.textContent)) dress(b, "search", "Search (Ctrl+K)");
  }
  // ---------- colour palettes ----------
  // Each mode has its own palette (remembered separately), so switching light /
  // dark keeps both. Only the surfaces, text and the accent change - red, amber
  // and green keep their meaning (overdue, warnings, done). Accents were chosen
  // so white button text and accent-coloured links both stay readable.
  const PALETTES = {
    light: {
      classic: { name: "Classic", sw: ["#f1ece4", "#4f46e5"] },
      ocean: { name: "Ocean", v: { bg: "#edf3f7", card: "#f9fcfe", bg2: "#e2ecf3", border: "#cddbe6", field: "#ffffff", text: "#1d2a35", muted: "#5a6b7a", indigo: "#0e7490", "indigo-dark": "#155e75" } },
      forest: { name: "Forest", v: { bg: "#eef3ec", card: "#f9fbf7", bg2: "#e2eadd", border: "#cfdac8", field: "#ffffff", text: "#1f2a1f", muted: "#5d6b5a", indigo: "#2f7d4f", "indigo-dark": "#276a42" } },
      rose: { name: "Rose", v: { bg: "#f8eff1", card: "#fffafb", bg2: "#f1e2e6", border: "#e6cfd6", field: "#ffffff", text: "#2e2226", muted: "#75606a", indigo: "#be185d", "indigo-dark": "#9d174d" } },
      lavender: { name: "Lavender", v: { bg: "#f1eff8", card: "#fcfbff", bg2: "#e6e2f3", border: "#d7d0ea", field: "#ffffff", text: "#25213a", muted: "#655e7c", indigo: "#6d28d9", "indigo-dark": "#5b21b6" } },
      slate: { name: "Slate", v: { bg: "#eef0f3", card: "#fafbfc", bg2: "#e3e7ec", border: "#d1d7df", field: "#ffffff", text: "#1e2530", muted: "#5c6675", indigo: "#2563eb", "indigo-dark": "#1d4ed8" } },
    },
    dark: {
      classic: { name: "Classic", sw: ["#0f1115", "#6366f1"] },
      midnight: { name: "Midnight", v: { bg: "#0b1220", card: "#111a2d", bg2: "#18233a", border: "#263350", field: "#111a2d", text: "#e6ebf5", muted: "#93a1bb", indigo: "#3b82f6", "indigo-dark": "#2563eb" } },
      pine: { name: "Pine", v: { bg: "#0d1411", card: "#142019", bg2: "#1b2a21", border: "#2a3b30", field: "#142019", text: "#e3ede6", muted: "#95a99b", indigo: "#059669", "indigo-dark": "#047857" } },
      plum: { name: "Plum", v: { bg: "#140f1b", card: "#1d1626", bg2: "#261d32", border: "#372a47", field: "#1d1626", text: "#ece6f5", muted: "#a597b8", indigo: "#a855f7", "indigo-dark": "#9333ea" } },
      mocha: { name: "Mocha", v: { bg: "#16120f", card: "#201a16", bg2: "#2a231d", border: "#3a3129", field: "#201a16", text: "#f0e8e0", muted: "#b0a191", indigo: "#ea580c", "indigo-dark": "#c2410c" } },
    },
  };
  const vars = (v) => Object.entries(v).map(([k, x]) => "--" + k + ": " + x + ";").join(" ");
  const pcss = document.createElement("style");
  pcss.textContent = Object.entries(PALETTES.light).filter(([, p]) => p.v).map(([k, p]) => `html[data-pal-light="${k}"]:not([data-theme="dark"]) { ${vars(p.v)} }`).join("\n") + "\n" +
    Object.entries(PALETTES.dark).filter(([, p]) => p.v).map(([k, p]) => `html[data-theme="dark"][data-pal-dark="${k}"] { ${vars(p.v)} }`).join("\n") + `
  .pcm-thm { position: fixed; z-index: 2147483000; width: 248px; background: var(--card); color: var(--text); border: 1px solid var(--border); border-radius: 12px; box-shadow: 0 12px 32px rgba(0,0,0,.18); padding: 12px; font: 13px system-ui, -apple-system, "Segoe UI", sans-serif; }
  .pcm-thm .seg { display: grid; grid-template-columns: 1fr 1fr; border: 1px solid var(--border); border-radius: 8px; overflow: hidden; margin-bottom: 12px; }
  .pcm-thm .seg button { font: inherit; font-size: 12.5px; padding: 6px; border: 0; background: none; color: var(--muted); cursor: pointer; }
  .pcm-thm .seg button.on { background: var(--indigo); color: #fff; }
  .pcm-thm h4 { margin: 0 0 6px; font-size: 11px; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); }
  .pcm-thm .sws { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; margin-bottom: 12px; }
  .pcm-thm .sws:last-child { margin-bottom: 0; }
  .pcm-thm .sw { font: inherit; font-size: 11.5px; color: var(--text); background: none; border: 1px solid var(--border); border-radius: 8px; padding: 6px 4px 5px; cursor: pointer; display: flex; flex-direction: column; align-items: center; gap: 4px; }
  .pcm-thm .sw:hover { border-color: var(--indigo); }
  .pcm-thm .sw.on { border-color: var(--indigo); box-shadow: 0 0 0 1px var(--indigo); }
  .pcm-thm .sw i { width: 34px; height: 16px; border-radius: 5px; border: 1px solid rgba(127,127,127,.35); background: linear-gradient(90deg, var(--a) 0 58%, var(--b) 58% 100%); }
  `;
  document.head.appendChild(pcss);
  const root = document.documentElement;
  function setPal(g) {
    const l = g && g.themePaletteLight, d = g && g.themePaletteDark;
    if (l && PALETTES.light[l] && PALETTES.light[l].v) root.dataset.palLight = l; else delete root.dataset.palLight;
    if (d && PALETTES.dark[d] && PALETTES.dark[d].v) root.dataset.palDark = d; else delete root.dataset.palDark;
  }
  try {
    chrome.storage.local.get(["themePaletteLight", "themePaletteDark"]).then(setPal).catch(() => {});
    chrome.storage.onChanged.addListener((ch, area) => {
      if (area !== "local") return;
      if (ch.themePaletteLight || ch.themePaletteDark) chrome.storage.local.get(["themePaletteLight", "themePaletteDark"]).then(setPal).catch(() => {});
      if (ch.theme && ch.theme.newValue && typeof window.applyTheme === "function" && root.dataset.theme !== ch.theme.newValue) window.applyTheme(ch.theme.newValue);
    });
  } catch (e) {}
  let menu = null;
  const closeMenu = () => { if (menu) { menu.remove(); menu = null; } };
  async function setMode(mode) {
    if (typeof window.applyTheme === "function") window.applyTheme(mode); else root.dataset.theme = mode;
    try { await chrome.storage.local.set({ theme: mode }); } catch (e) {}
  }
  function openMenu(btn) {
    closeMenu();
    menu = document.createElement("div");
    menu.className = "pcm-thm";
    menu.setAttribute("role", "dialog");
    menu.setAttribute("aria-label", "Theme");
    const paint = () => {
      const mode = root.dataset.theme === "dark" ? "dark" : "light";
      const cur = { light: root.dataset.palLight || "classic", dark: root.dataset.palDark || "classic" };
      const sws = (m) => Object.entries(PALETTES[m]).map(([k, p]) => {
        const [a, b] = p.sw || [p.v.bg, p.v.indigo];
        return '<button type="button" class="sw' + (cur[m] === k && mode === m ? " on" : "") + '" data-m="' + m + '" data-p="' + k + '"><i style="--a:' + a + ";--b:" + b + '"></i>' + p.name + "</button>";
      }).join("");
      menu.innerHTML = '<div class="seg"><button type="button" data-mode="light" class="' + (mode === "light" ? "on" : "") + '">☀ Light</button><button type="button" data-mode="dark" class="' + (mode === "dark" ? "on" : "") + '">☾ Dark</button></div>' +
        "<h4>Light palettes</h4><div class=\"sws\">" + sws("light") + "</div><h4>Dark palettes</h4><div class=\"sws\">" + sws("dark") + "</div>";
      menu.querySelectorAll("[data-mode]").forEach((b) => { b.onclick = async () => { await setMode(b.dataset.mode); paint(); }; });
      menu.querySelectorAll("[data-p]").forEach((b) => {
        b.onclick = async () => {
          const m = b.dataset.m, p = b.dataset.p;
          const key = m === "light" ? "themePaletteLight" : "themePaletteDark";
          setPal({ themePaletteLight: m === "light" ? p : root.dataset.palLight, themePaletteDark: m === "dark" ? p : root.dataset.palDark });
          try { await chrome.storage.local.set({ [key]: p }); } catch (e) {}
          await setMode(m);
          paint();
        };
      });
    };
    paint();
    document.body.appendChild(menu);
    const r = btn.getBoundingClientRect();
    menu.style.top = Math.round(r.bottom + 6) + "px";
    const vw = window.innerWidth || document.documentElement.clientWidth || 800;
    menu.style.left = Math.round(Math.max(8, Math.min(vw - 256, r.right - 248))) + "px";
  }
  function hookTheme() {
    const btn = document.getElementById("themeToggle");
    if (!btn || btn._pcmThm) return;
    btn._pcmThm = true;
    btn.title = "Theme: light / dark and colour palettes";
    btn.setAttribute("aria-haspopup", "dialog");
    // Capture phase: runs before the page's own one-click toggle, which it replaces.
    btn.addEventListener("click", (e) => { e.preventDefault(); e.stopImmediatePropagation(); if (menu) closeMenu(); else openMenu(btn); }, true);
  }
  document.addEventListener("click", (e) => { if (menu && !menu.contains(e.target) && e.target.id !== "themeToggle") closeMenu(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeMenu(); });

  apply();
  hookTheme();
  // Some buttons arrive a moment later (reminders, notifications, search).
  const host = document.querySelector(".header .header-actions") || document.querySelector(".hdr-tools") || document.body;
  const mo = new MutationObserver(() => { apply(); hookTheme(); });
  mo.observe(host, { childList: true, subtree: true });
  setTimeout(() => mo.disconnect(), 8000);
  document.addEventListener("DOMContentLoaded", () => { apply(); hookTheme(); });
})();
