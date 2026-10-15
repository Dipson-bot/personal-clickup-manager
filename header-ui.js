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
  .pcm-ib[hidden] { display: none !important; }
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
      sand: { name: "Sand", v: { bg: "#f6f1e7", card: "#fffdf8", bg2: "#ece4d4", border: "#e0d5c0", field: "#ffffff", text: "#2b261d", muted: "#6f6656", indigo: "#b45309", "indigo-dark": "#92400e" } },
      mint: { name: "Mint", v: { bg: "#ecf6f3", card: "#f8fdfb", bg2: "#dcefe9", border: "#c7e2da", field: "#ffffff", text: "#1b2b27", muted: "#58706a", indigo: "#0f766e", "indigo-dark": "#115e59" } },
      coral: { name: "Coral", v: { bg: "#fbf0ec", card: "#fffaf8", bg2: "#f4e1da", border: "#ead0c6", field: "#ffffff", text: "#2e2420", muted: "#77625a", indigo: "#c2410c", "indigo-dark": "#9a3412" } },
      mono: { name: "Mono", v: { bg: "#f2f2f2", card: "#fbfbfb", bg2: "#e7e7e7", border: "#d6d6d6", field: "#ffffff", text: "#1f1f1f", muted: "#636363", indigo: "#374151", "indigo-dark": "#1f2937" } },
    },
    dark: {
      classic: { name: "Classic", sw: ["#0f1115", "#6366f1"] },
      midnight: { name: "Midnight", v: { bg: "#0b1220", card: "#111a2d", bg2: "#18233a", border: "#263350", field: "#111a2d", text: "#e6ebf5", muted: "#93a1bb", indigo: "#3b82f6", "indigo-dark": "#2563eb" } },
      pine: { name: "Pine", v: { bg: "#0d1411", card: "#142019", bg2: "#1b2a21", border: "#2a3b30", field: "#142019", text: "#e3ede6", muted: "#95a99b", indigo: "#059669", "indigo-dark": "#047857" } },
      plum: { name: "Plum", v: { bg: "#140f1b", card: "#1d1626", bg2: "#261d32", border: "#372a47", field: "#1d1626", text: "#ece6f5", muted: "#a597b8", indigo: "#a855f7", "indigo-dark": "#9333ea" } },
      mocha: { name: "Mocha", v: { bg: "#16120f", card: "#201a16", bg2: "#2a231d", border: "#3a3129", field: "#201a16", text: "#f0e8e0", muted: "#b0a191", indigo: "#ea580c", "indigo-dark": "#c2410c" } },
      graphite: { name: "Graphite", v: { bg: "#121212", card: "#1b1b1b", bg2: "#242424", border: "#333333", field: "#1b1b1b", text: "#ececec", muted: "#a3a3a3", indigo: "#64748b", "indigo-dark": "#475569" } },
      deepsea: { name: "Deep sea", v: { bg: "#0a1618", card: "#102226", bg2: "#162e33", border: "#24434b", field: "#102226", text: "#e2f0f1", muted: "#8fb0b4", indigo: "#0891b2", "indigo-dark": "#0e7490" } },
      wine: { name: "Wine", v: { bg: "#170d10", card: "#221418", bg2: "#2d1a20", border: "#40252d", field: "#221418", text: "#f3e6ea", muted: "#b7959f", indigo: "#e11d48", "indigo-dark": "#be123c" } },
      nord: { name: "Nord", v: { bg: "#1f242d", card: "#272d38", bg2: "#2e3542", border: "#3b4252", field: "#272d38", text: "#e5e9f0", muted: "#a3adbf", indigo: "#5e81ac", "indigo-dark": "#4c6a94" } },
    },
  };
  // ---------- your own palette ----------
  // Three colours per mode (background, cards, accent); everything else is
  // worked out from them so text, borders and buttons stay readable whatever
  // is picked. Kept in storage themeCustomLight / themeCustomDark.
  const hexOk = (s) => (/^#[0-9a-f]{6}$/i.test(String(s || "")) ? String(s).toLowerCase() : null);
  const rgbOf = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const toHex = (a) => "#" + a.map((x) => Math.round(Math.max(0, Math.min(255, x))).toString(16).padStart(2, "0")).join("");
  const mixHex = (a, b, t) => { const x = rgbOf(a), y = rgbOf(b); return toHex(x.map((v, i) => v + (y[i] - v) * t)); };
  const lumOf = (h) => { const c = rgbOf(h).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
  const contrastOf = (a, b) => { const x = lumOf(a), y = lumOf(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const CUSTOM_DEFAULT = { light: { bg: "#eef1f6", card: "#ffffff", accent: "#4f46e5" }, dark: { bg: "#101318", card: "#181c23", accent: "#6366f1" } };
  function deriveCustom(c, mode) {
    const d = CUSTOM_DEFAULT[mode] || CUSTOM_DEFAULT.light;
    const bg = hexOk(c && c.bg) || d.bg, card = hexOk(c && c.card) || d.card;
    let acc = hexOk(c && c.accent) || d.accent;
    // White button text has to stay readable on the accent: darken until it is.
    for (let i = 0; i < 14 && contrastOf(acc, "#ffffff") < 3.2; i++) acc = mixHex(acc, "#000000", 0.12);
    const darkCard = lumOf(card) < 0.3;
    // On a dark card the accent has to show as a link too.
    for (let i = 0; i < 8 && darkCard && contrastOf(acc, card) < 2.4; i++) acc = mixHex(acc, "#ffffff", 0.1);
    const text = darkCard ? "#ececf1" : "#1f1d24";
    return { bg, card, bg2: mixHex(card, text, 0.06), border: mixHex(card, text, 0.16), field: darkCard ? card : "#ffffff", text, muted: mixHex(text, card, 0.42), indigo: acc, "indigo-dark": mixHex(acc, "#000000", 0.15) };
  }
  let customs = { light: null, dark: null };
  // Saved looks (☀ menu › Your looks, General › Appearance): light / dark, both
  // palettes, your own colours and the wallpaper with its settings - switched in
  // one click. themeLooks = [{ id, name, theme, palLight, palDark, customLight,
  // customDark, wall, imgKey, thumb }]; each picture is kept once under its own
  // key (themeLookImg_…), shared by looks that use the same one.
  const LOOK_MAX = 8;
  let looks = [];
  // The Appearance card's colour boxes, refilled whenever the saved palettes
  // arrive (they load a moment after the page) - otherwise the boxes showed the
  // defaults and changing one colour saved the other two as defaults.
  const apRefills = [];
  const vars = (v) => Object.entries(v).map(([k, x]) => "--" + k + ": " + x + ";").join(" ");
  const pcss = document.createElement("style");
  pcss.textContent = Object.entries(PALETTES.light).filter(([, p]) => p.v).map(([k, p]) => `html[data-pal-light="${k}"]:not([data-theme="dark"]) { ${vars(p.v)} }`).join("\n") + "\n" +
    Object.entries(PALETTES.dark).filter(([, p]) => p.v).map(([k, p]) => `html[data-theme="dark"][data-pal-dark="${k}"] { ${vars(p.v)} }`).join("\n") + `
  .pcm-thm { position: fixed; z-index: 2147483000; width: 248px; background: var(--card); color: var(--text); border: 1px solid var(--border); border-radius: 12px; box-shadow: 0 12px 32px rgba(0,0,0,.18); padding: 12px; font: 13px system-ui, -apple-system, "Segoe UI", sans-serif; }
  .pcm-thm .seg { display: grid; grid-template-columns: 1fr 1fr; border: 1px solid var(--border); border-radius: 8px; overflow: hidden; margin-bottom: 12px; }
  .pcm-thm .seg button { font: inherit; font-size: 12.5px; padding: 6px; border: 0; background: none; color: var(--muted); cursor: pointer; }
  .pcm-thm .seg button.on { background: var(--indigo); color: #fff; }
  .pcm-thm .seg.seg3 { grid-template-columns: 1fr 1fr 1fr; }
  .pcm-thm .seg.seg3 button { font-size: 11.5px; padding: 6px 2px; }
  .pcm-thm .wxs { display: flex; align-items: center; gap: 6px; margin: -4px 0 12px; font-size: 11px; color: var(--muted); }
  .pcm-thm .wxs input { flex: 1; min-width: 0; margin: 0; }
  .pcm-thm h4 { margin: 0 0 6px; font-size: 11px; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); }
  .pcm-thm .sws { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; margin-bottom: 12px; }
  .pcm-thm .sws:last-child { margin-bottom: 0; }
  .pcm-thm .sw { font: inherit; font-size: 11.5px; color: var(--text); background: none; border: 1px solid var(--border); border-radius: 8px; padding: 6px 4px 5px; cursor: pointer; display: flex; flex-direction: column; align-items: center; gap: 4px; }
  .pcm-thm .sw:hover { border-color: var(--indigo); }
  .pcm-thm .sw.on { border-color: var(--indigo); box-shadow: 0 0 0 1px var(--indigo); }
  .pcm-thm .sw i { width: 34px; height: 16px; border-radius: 5px; border: 1px solid rgba(127,127,127,.35); background: linear-gradient(90deg, var(--a) 0 58%, var(--b) 58% 100%); }
  .pcm-thm { overflow-y: auto; }
  .pcm-thm .thm-more { display: block; width: 100%; margin-top: 2px; font: inherit; font-size: 12.5px; padding: 7px; border: 1px dashed var(--border); border-radius: 8px; background: none; color: var(--indigo); cursor: pointer; }
  .pcm-thm .thm-more:hover { border-color: var(--indigo); }
  /* Wallpaper (Options › General › Appearance): behind everything, sized to any
     screen - "cover" crops the edges, "contain" shows the whole picture. */
  html.pcm-wall { background: var(--bg); }
  html.pcm-wall body { background: transparent !important; }
  #pcmWall { position: fixed; inset: 0; z-index: -1; pointer-events: none; overflow: hidden; }
  #pcmWall .wvid { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: var(--wfit, cover); filter: blur(var(--wblur, 0px)); }
  #pcmWall .wimg { position: absolute; inset: -40px; background-position: center; background-repeat: no-repeat; background-size: var(--wfit, cover); filter: blur(var(--wblur, 0px)); }
  .lk-list { display: flex; flex-wrap: wrap; gap: 6px; margin: 0 0 10px; }
  .lk { position: relative; display: inline-flex; }
  .lk-use { display: inline-flex; flex-direction: column; align-items: center; gap: 3px; font: inherit; font-size: 11px; width: 74px; padding: 4px; margin: 0; border: 1px solid var(--border); border-radius: 9px; background: var(--card); color: var(--text); cursor: pointer; }
  .lk-use:hover { border-color: var(--indigo); }
  .lk-use span { max-width: 66px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .lk-th { position: relative; display: block; width: 64px; height: 38px; border-radius: 6px; border: 1px solid var(--border); }
  .lk-th b { position: absolute; right: 3px; bottom: 3px; width: 10px; height: 10px; border-radius: 50%; border: 1.5px solid #fff; }
  .lk-x { position: absolute; top: -6px; right: -6px; width: 18px; height: 18px; padding: 0; margin: 0; font-size: 10px; line-height: 16px; border-radius: 50%; border: 1px solid var(--border); background: var(--card); color: var(--muted); cursor: pointer; display: none; }
  .lk:hover .lk-x { display: block; }
  .lk-save { font: inherit; font-size: 11.5px; padding: 4px 10px; margin: 0; width: auto; border: 1px dashed var(--border); border-radius: 9px; background: none; color: var(--indigo); cursor: pointer; align-self: center; }
  .ap-looks { margin: 0 0 14px; }
  #pcmWall .wdim { position: absolute; inset: 0; background: var(--bg); opacity: var(--wdim, .35); }
  html.pcm-wall.pcm-glass .card, html.pcm-wall.pcm-glass .sidenav { background: color-mix(in srgb, var(--card) var(--pcm-glass, 84%), transparent) !important; backdrop-filter: blur(10px); }
  `;
  document.head.appendChild(pcss);
  const ccss = document.createElement("style"); // your own palettes (rewritten when they change)
  document.head.appendChild(ccss);
  const root = document.documentElement;
  const okPal = (m, k) => (k === "custom" ? !!customs[m] : !!(k && PALETTES[m][k] && PALETTES[m][k].v));
  function paintCustomCss() {
    ccss.textContent = (customs.light ? 'html[data-pal-light="custom"]:not([data-theme="dark"]) { ' + vars(deriveCustom(customs.light, "light")) + " }\n" : "") +
      (customs.dark ? 'html[data-theme="dark"][data-pal-dark="custom"] { ' + vars(deriveCustom(customs.dark, "dark")) + " }" : "");
  }
  function setPal(g) {
    if (g && "themeLooks" in g) {
      looks = (Array.isArray(g.themeLooks) ? g.themeLooks : []).filter((l) => l && l.id).slice(0, LOOK_MAX);
      apRefills.forEach((fn) => { try { fn(); } catch (e) {} });
    }
    if (g && ("themeCustomLight" in g || "themeCustomDark" in g)) {
      customs = { light: (g.themeCustomLight && typeof g.themeCustomLight === "object") ? g.themeCustomLight : null, dark: (g.themeCustomDark && typeof g.themeCustomDark === "object") ? g.themeCustomDark : null };
      paintCustomCss();
      apRefills.forEach((f) => { try { f(); } catch (e) {} });
    }
    const l = g && g.themePaletteLight, d = g && g.themePaletteDark;
    if (okPal("light", l)) root.dataset.palLight = l; else delete root.dataset.palLight;
    if (okPal("dark", d)) root.dataset.palDark = d; else delete root.dataset.palDark;
  }
  const PAL_KEYS = ["themePaletteLight", "themePaletteDark", "themeCustomLight", "themeCustomDark", "themeLooks"];
  try {
    chrome.storage.local.get(PAL_KEYS).then(setPal).catch(() => {});
    chrome.storage.onChanged.addListener((ch, area) => {
      if (area !== "local") return;
      if (PAL_KEYS.some((k) => ch[k])) chrome.storage.local.get(PAL_KEYS).then(setPal).catch(() => {});
      if (ch.themeWall || ch.themeWallImg || ch.themeScene || ch.themeWallVideo) loadWall();
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
      }).join("") + (() => {
        // Your own palette: pick it, or (not made yet) go and make it.
        const c = customs[m];
        if (!c) return '<button type="button" class="sw" data-edit="1" title="Make your own palette (Options › General › Appearance)"><i style="--a:transparent;--b:transparent;border-style:dashed"></i>+ Custom</button>';
        const v = deriveCustom(c, m);
        return '<button type="button" class="sw' + (cur[m] === "custom" && mode === m ? " on" : "") + '" data-m="' + m + '" data-p="custom" title="Your own palette"><i style="--a:' + v.bg + ";--b:" + v.indigo + '"></i>Custom</button>';
      })();
      menu.innerHTML ='<div class="seg"><button type="button" data-mode="light" class="' + (mode === "light" ? "on" : "") + '">☀ Light</button><button type="button" data-mode="dark" class="' + (mode === "dark" ? "on" : "") + '">☾ Dark</button></div>' +
        "<h4>Background</h4><div class=\"seg seg3\">" + [["weather", "\uD83C\uDF26 Task weather", "Follows the running task: snow at the start, sun on the estimate, storms past it (animated - uses a little more of the computer)"], ["plain", "Plain", "No background"], ["wall", "\uD83D\uDDBC Wallpaper", "Your own picture or video"]].map(([k, t, tip]) => '<button type="button" data-scene="' + k + '" title="' + tip + '" class="' + (scene === k ? "on" : "") + '">' + t + "</button>").join("") + "</div>" +
        (scene !== "plain" ? '<label class="wxs" title="How see-through the cards are - make them solid if text is hard to read">Cards: glassy<input type="range" min="0" max="100" step="10" data-card-solid value="' + cardSolid + '" aria-label="Cards: glassy to solid" />solid</label>' : "") +
        (scene === "weather" && window.PcmWeather ? '<label class="wxs" title="How strong the weather behind is - softer is calmer">Weather: softer<input type="range" min="0" max="100" step="5" data-wx-strength value="' + window.PcmWeather.strength + '" aria-label="Weather strength" />stronger</label>' : "") +
        "<h4>Your looks</h4><div class=\"lk-list\">" + defaultTile() + looks.map(lookTile).join("") + '<button type="button" class="lk-save" data-look-save="1" title="Keep the colours, light / dark and the wallpaper you have on now">\uFF0B Save current look\u2026</button></div>' +
        "<h4>Light palettes</h4><div class=\"sws\">" + sws("light") + "</div><h4>Dark palettes</h4><div class=\"sws\">" + sws("dark") + "</div>" +
        '<button type="button" class="thm-more" data-edit="1">🎨 Custom colours &amp; wallpaper…</button>';
      menu.querySelectorAll("[data-edit]").forEach((b) => { b.onclick = () => { closeMenu(); openAppearance(); }; });
      menu.querySelectorAll("[data-mode]").forEach((b) => { b.onclick = async () => { await setMode(b.dataset.mode); paint(); }; });
      const cs = menu.querySelector("[data-card-solid]");
      if (cs) cs.oninput = () => { setCards(Number(cs.value)); const a = document.getElementById("apCardSolid"); if (a) a.value = cs.value; };
      const wxs = menu.querySelector("[data-wx-strength]");
      if (wxs) wxs.oninput = () => { window.PcmWeather.setStrength(Number(wxs.value)); const a = document.getElementById("apWxStrength"); if (a) a.value = wxs.value; };
      menu.querySelectorAll("[data-scene]").forEach((b) => { b.onclick = async () => {
        // Wallpaper with none chosen yet: go and choose one.
        if (b.dataset.scene === "wall" && !lastImg && !vidMeta) { closeMenu(); openAppearance(); return; }
        await setScene(b.dataset.scene); paint();
      }; });
      menu.querySelectorAll("[data-look]").forEach((b) => { b.onclick = async () => { await useLook(looks.find((l) => l.id === b.dataset.look)); paint(); }; });
      menu.querySelectorAll("[data-look-default]").forEach((b) => { b.onclick = async () => { await useDefaultLook(); paint(); }; });
      menu.querySelectorAll("[data-look-x]").forEach((b) => { b.onclick = async (e) => { e.stopPropagation(); const l = looks.find((x) => x.id === b.dataset.lookX); if (l && confirm("Delete the look \u201c" + l.name + "\u201d?")) { await deleteLook(l); paint(); } }; });
      const ls = menu.querySelector("[data-look-save]");
      if (ls) ls.onclick = async (e) => { e.stopPropagation(); if (await askSaveLook(null)) paint(); };
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
    menu.style.maxHeight = Math.max(160, (window.innerHeight || 600) - Math.round(r.bottom + 6) - 8) + "px";
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

  // ---------- wallpaper ----------
  // themeWall { fit: "cover" | "contain", dim 0-85, blur 0-20, glass, popup }
  // themeWallImg: the picture as a data URL, shrunk to at most 2560 px on its
  // long side when it was chosen (so any size or shape of image works, and it
  // stays small), kept separately so moving a slider doesn't rewrite it.
  const WALL_DEF = { fit: "cover", dim: 35, blur: 0, glass: true, popup: true };
  // Background: "plain" (the default), "weather" (Task weather, weather.js -
  // animated, so only when chosen), or "wall" (your picture / video). themeScene.
  const SCENES = ["weather", "plain", "wall"];
  // Cards over a background (Task weather or a wallpaper): themeCards.solid 0-100
  // - 0 = glassy (70% card colour), 100 = fully solid (best for reading).
  let cardSolid = 50;
  function applyCards(v) {
    cardSolid = Math.max(0, Math.min(100, Number.isFinite(Number(v)) ? Number(v) : 50));
    root.style.setProperty("--pcm-glass", Math.round(70 + cardSolid * .3) + "%");
    root.classList.toggle("pcm-solid", cardSolid >= 100);
  }
  applyCards(50);
  try {
    chrome.storage.local.get("themeCards").then((g) => applyCards(g && g.themeCards && g.themeCards.solid)).catch(() => {});
    chrome.storage.onChanged.addListener((ch, area) => { if (area === "local" && ch.themeCards) { applyCards(ch.themeCards.newValue && ch.themeCards.newValue.solid); const a = document.getElementById("apCardSolid"); if (a && document.activeElement !== a) a.value = String(cardSolid); } });
  } catch (e) {}
  const setCards = (v) => { applyCards(v); try { chrome.storage.local.set({ themeCards: { solid: cardSolid } }); } catch (e) {} };
  let scene = "plain";
  async function setScene(s) {
    scene = SCENES.includes(s) ? s : "plain";
    try { await chrome.storage.local.set({ themeScene: scene }); } catch (e) {}
    paintWall(lastWall, lastImg); paintAppearance(lastWall, lastImg);
  }
  // A video or animated GIF wallpaper is too big for extension storage: the file
  // itself is kept in this computer's IndexedDB (pcm-wallpaper › files › "wall"),
  // its description in themeWallVideo { kind: "video" | "gif", name, size, type, at }.
  let vidMeta = null, vidUrl = "", vidAt = 0;
  const sizeText = (n) => (n = Number(n) || 0) >= 1048576 ? Math.round(n / 1048576 * 10) / 10 + " MB" : Math.max(1, Math.round(n / 1024)) + " KB";
  const idb = () => new Promise((res, rej) => { const r = indexedDB.open("pcm-wallpaper", 1); r.onupgradeneeded = () => r.result.createObjectStore("files"); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const idbDo = async (mode, fn) => { const db = await idb(); return new Promise((res, rej) => { const tx = db.transaction("files", mode); const req = fn(tx.objectStore("files")); tx.oncomplete = () => res(req && req.result); tx.onerror = () => rej(tx.error); }); };
  const idbPut = (k, v) => idbDo("readwrite", (s) => s.put(v, k));
  const idbGet = (k) => idbDo("readonly", (s) => s.get(k));
  const idbDel = (k) => idbDo("readwrite", (s) => s.delete(k));
  async function motionUrl() {
    if (!vidMeta) return "";
    if (vidUrl && vidAt === vidMeta.at) return vidUrl;
    const blob = await idbGet("wall").catch(() => null);
    if (vidUrl) URL.revokeObjectURL(vidUrl);
    vidUrl = blob ? URL.createObjectURL(blob) : ""; vidAt = vidMeta.at;
    return vidUrl;
  }
  document.addEventListener("visibilitychange", () => { const v = wallEl && wallEl.querySelector("video"); if (v) { if (document.hidden) v.pause(); else v.play().catch(() => {}); } });
  const inToolbarPopup = /\/popup\.html$/.test(location.pathname) && !root.classList.contains("in-panel");
  let wallEl = null;
  function paintWall(w, img) {
    const W = window.PcmWeather;
    if (W) { if (scene === "weather") W.start(); else W.stop(); }
    const on = scene === "wall" && (!!img || !!vidMeta) && !(inToolbarPopup && w.popup === false) && !(/\/popup\.html$/.test(location.pathname) && w.popup === false);
    root.classList.toggle("pcm-wall", on);
    root.classList.toggle("pcm-glass", on && w.glass !== false);
    if (!on) { if (wallEl) { wallEl.remove(); wallEl = null; } return; }
    if (!wallEl) {
      wallEl = document.createElement("div");
      wallEl.id = "pcmWall";
      wallEl.setAttribute("aria-hidden", "true");
      wallEl.innerHTML = '<div class="wimg"></div><div class="wdim"></div>';
      (document.body || document.documentElement).appendChild(wallEl);
    }
    const im = wallEl.querySelector(".wimg");
    let vid = wallEl.querySelector("video");
    if (vidMeta) {
      // Video / animated GIF from IndexedDB (an object URL, made once per file).
      motionUrl().then((u) => {
        if (!wallEl || !u) return;
        if (vidMeta.kind === "video") {
          im.style.backgroundImage = ""; im._url = "";
          if (!vid) { vid = document.createElement("video"); vid.className = "wvid"; vid.muted = true; vid.loop = true; vid.autoplay = true; vid.playsInline = true; vid.setAttribute("aria-hidden", "true"); im.after(vid); }
          if (vid.src !== u) vid.src = u;
          if (!document.hidden) vid.play().catch(() => {});
        } else {
          if (vid) vid.remove();
          const url2 = 'url("' + u + '")';
          if (im._url !== url2) { im._url = url2; im.style.backgroundImage = url2; }
        }
      });
    } else {
      if (vid) vid.remove();
      const url = 'url("' + img + '")';
      if (im._url !== url) { im._url = url; im.style.backgroundImage = url; }
    }
    wallEl.style.setProperty("--wfit", w.fit === "contain" ? "contain" : "cover");
    wallEl.style.setProperty("--wblur", Math.max(0, Math.min(20, Number(w.blur) || 0)) + "px");
    wallEl.style.setProperty("--wdim", String(Math.max(0, Math.min(85, Number(w.dim != null ? w.dim : 35))) / 100));
  }
  function loadWall() {
    try {
      chrome.storage.local.get(["themeWall", "themeWallImg", "themeScene", "themeWallVideo"]).then((g) => {
        scene = SCENES.includes(g && g.themeScene) ? g.themeScene : "plain";
        vidMeta = g && g.themeWallVideo && g.themeWallVideo.at ? g.themeWallVideo : null;
        const w = { ...WALL_DEF, ...((g && g.themeWall) || {}) };
        const img = typeof (g && g.themeWallImg) === "string" && /^data:image\//.test(g.themeWallImg) ? g.themeWallImg : "";
        const go = () => { paintWall(w, img); paintAppearance(w, img); };
        if (document.body) go(); else document.addEventListener("DOMContentLoaded", go, { once: true });
      }).catch(() => {});
    } catch (e) {}
  }
  // Any picture -> at most 2560 px on its long side, WebP (keeps transparency),
  // smaller again if it is still large.
  async function shrinkImage(file) {
    const bmp = await createImageBitmap(file);
    let side = 2560, q = 0.86, out = "";
    for (let pass = 0; pass < 5; pass++) {
      const k = Math.min(1, side / Math.max(bmp.width, bmp.height));
      const cv = document.createElement("canvas");
      cv.width = Math.max(1, Math.round(bmp.width * k)); cv.height = Math.max(1, Math.round(bmp.height * k));
      cv.getContext("2d").drawImage(bmp, 0, 0, cv.width, cv.height);
      out = cv.toDataURL("image/webp", q);
      if (!/^data:image\/webp/.test(out)) out = cv.toDataURL("image/jpeg", q);
      if (out.length < 1.4e6) return { data: out, w: cv.width, h: cv.height, src: [bmp.width, bmp.height] }; // ~1 MB at most: storage is shared with everything else
      side = Math.round(side * 0.8); q = Math.max(0.6, q - 0.08);
    }
    return { data: out, w: 0, h: 0, src: [bmp.width, bmp.height] };
  }

  // ---------- saved looks ----------
  async function lookThumb(img) {
    if (!img) return "";
    try {
      const bmp = await createImageBitmap(await (await fetch(img)).blob());
      const cv = document.createElement("canvas"); cv.width = 96; cv.height = 60;
      const k = Math.max(96 / bmp.width, 60 / bmp.height);
      cv.getContext("2d").drawImage(bmp, (96 - bmp.width * k) / 2, (60 - bmp.height * k) / 2, bmp.width * k, bmp.height * k);
      return cv.toDataURL("image/jpeg", 0.7);
    } catch (e) { return ""; }
  }
  async function saveLook(name) {
    const g = await chrome.storage.local.get(["theme", "themePaletteLight", "themePaletteDark", "themeCustomLight", "themeCustomDark", "themeWall", "themeWallImg"]).catch(() => ({}));
    const img = typeof g.themeWallImg === "string" && /^data:image\//.test(g.themeWallImg) ? g.themeWallImg : "";
    const same = looks.find((l) => l.name.toLowerCase() === name.toLowerCase());
    if (!same && looks.length >= LOOK_MAX) throw new Error("You can keep " + LOOK_MAX + " looks - delete one first (✕).");
    let imgKey = "";
    if (img) {
      // The same picture as another look: share its copy.
      for (const l of looks) {
        if (!l.imgKey) continue;
        const h = await chrome.storage.local.get(l.imgKey).catch(() => ({}));
        if (h[l.imgKey] === img) { imgKey = l.imgKey; break; }
      }
      if (!imgKey) { imgKey = "themeLookImg_" + Date.now().toString(36); await chrome.storage.local.set({ [imgKey]: img }); }
    }
    const look = {
      id: same ? same.id : "lk" + Date.now().toString(36), name: name.slice(0, 24),
      theme: g.theme === "dark" ? "dark" : "light",
      palLight: g.themePaletteLight || "classic", palDark: g.themePaletteDark || "classic",
      customLight: g.themeCustomLight || null, customDark: g.themeCustomDark || null,
      wall: img ? { ...WALL_DEF, ...(g.themeWall || {}) } : null, imgKey, thumb: await lookThumb(img), scene,
    };
    const next = looks.filter((l) => l.id !== look.id).concat(look);
    await chrome.storage.local.set({ themeLooks: next });
    looks = next;
    await dropUnusedLookImgs(same && same.imgKey !== imgKey ? [same.imgKey] : []);
    return look;
  }
  async function dropUnusedLookImgs(keys) {
    const gone = keys.filter((k) => k && !looks.some((l) => l.imgKey === k));
    if (gone.length) await chrome.storage.local.remove(gone).catch(() => {});
  }
  async function useLook(look) {
    if (!look) return;
    const patch = {
      theme: look.theme, themePaletteLight: look.palLight || "classic", themePaletteDark: look.palDark || "classic",
      themeCustomLight: look.customLight || null, themeCustomDark: look.customDark || null,
    };
    if (look.imgKey) {
      const h = await chrome.storage.local.get(look.imgKey).catch(() => ({}));
      if (h[look.imgKey]) { patch.themeWallImg = h[look.imgKey]; patch.themeWall = { ...WALL_DEF, ...(look.wall || {}) }; }
    }
    patch.themeScene = SCENES.includes(look.scene) ? look.scene : look.imgKey ? "wall" : "plain";
    scene = patch.themeScene;
    await chrome.storage.local.set(patch).catch(() => {});
    if (!patch.themeWallImg) { await chrome.storage.local.set({ themeWallImg: "" }).catch(() => {}); await chrome.storage.local.remove("themeWallImg").catch(() => {}); }
    setPal(patch);
    if (typeof window.applyTheme === "function") window.applyTheme(look.theme); else root.dataset.theme = look.theme;
    loadWall();
  }
  // The plain look: no background, Classic in both modes (light / dark stays as it is).
  async function useDefaultLook() {
    scene = "plain";
    await chrome.storage.local.set({ themeWallImg: "", themePaletteLight: "classic", themePaletteDark: "classic", themeScene: "plain" }).catch(() => {});
    await chrome.storage.local.remove("themeWallImg").catch(() => {});
    setPal({ themePaletteLight: "classic", themePaletteDark: "classic" });
    paintWall(lastWall, ""); lastImg = "";
    loadWall();
  }
  const defaultTile = () => '<span class="lk"><button type="button" class="lk-use" data-look-default="1" title="Plain: no wallpaper, the Classic colours"><i class="lk-th" style="background:linear-gradient(135deg,#f1ece4 50%,#0f1115 50%)"><b style="background:#6366f1"></b></i><span>Default</span></button></span>';
  async function deleteLook(look) {
    looks = looks.filter((l) => l.id !== look.id);
    await chrome.storage.local.set({ themeLooks: looks }).catch(() => {});
    await dropUnusedLookImgs([look.imgKey]);
  }
  // A look's tile: its wallpaper (or its background colour) with its accent.
  function lookTile(l) {
    const c = l.theme === "dark" ? (l.customDark && l.palDark === "custom" ? deriveCustom(l.customDark, "dark") : null) : (l.customLight && l.palLight === "custom" ? deriveCustom(l.customLight, "light") : null);
    const pal = l.theme === "dark" ? PALETTES.dark[l.palDark] : PALETTES.light[l.palLight];
    const bg = c ? c.bg : pal && pal.v ? pal.v.bg : pal && pal.sw ? pal.sw[0] : "#888";
    const acc = c ? c.indigo : pal && pal.v ? pal.v.indigo : pal && pal.sw ? pal.sw[1] : "#6366f1";
    const name = String(l.name || "Look").replace(/[<>&"]/g, "");
    return '<span class="lk"><button type="button" class="lk-use" data-look="' + l.id + '" title="Switch to ' + name + '"><i class="lk-th" style="background:' + (l.thumb ? 'url(' + l.thumb + ') center/cover' : bg) + '"><b style="background:' + acc + '"></b></i><span>' + name + '</span></button>' +
      '<button type="button" class="lk-x" data-look-x="' + l.id + '" title="Delete ' + name + '">\u2715</button></span>';
  }
  async function askSaveLook(say) {
    const name = (prompt("Name this look (the colours, light / dark and the wallpaper you have on now):", "My look " + (looks.length + 1)) || "").trim();
    if (!name) return null;
    try { const l = await saveLook(name); if (say) say("Saved \u201c" + l.name + "\u201d - switch to it in the \u2600 menu."); return l; }
    catch (e) { const msg = String((e && e.message) || e); if (say) say(msg, true); else alert(msg); return null; }
  }
  function wireLooks(c, say) {
    if (c.querySelector(".ap-looks")) return;
    const box = document.createElement("div");
    box.className = "ap-looks";
    box.innerHTML = '<h3 style="font-size:13px;margin:0 0 6px;">Your looks</h3><p class="hint" style="margin:0 0 8px;">A look keeps light / dark, the palettes and the wallpaper together; switch between them in one click here or in the \u2600 menu at the top of every page.</p><div class="lk-list"></div><button type="button" class="lk-save">\uFF0B Save this look\u2026</button>';
    const h = c.querySelector("h3");
    (h ? h : c.lastChild).before(box);
    const list = box.querySelector(".lk-list");
    const paint = () => {
      list.innerHTML = defaultTile() + looks.map(lookTile).join("");
      list.querySelectorAll("[data-look-default]").forEach((b) => { b.onclick = async () => { await useDefaultLook(); say("Back to the plain look (no wallpaper, Classic colours)."); }; });
      list.querySelectorAll("[data-look]").forEach((b) => { b.onclick = async () => { await useLook(looks.find((l) => l.id === b.dataset.look)); say("\u201c" + b.textContent + "\u201d is on."); }; });
      list.querySelectorAll("[data-look-x]").forEach((b) => { b.onclick = async () => { const l = looks.find((x) => x.id === b.dataset.lookX); if (l && confirm("Delete the look \u201c" + l.name + "\u201d?")) { await deleteLook(l); paint(); } }; });
    };
    box.querySelector(".lk-save").onclick = async () => { if (await askSaveLook(say)) paint(); };
    paint();
    apRefills.push(paint);
  }

  // ---------- Appearance card (Options › General) ----------
  function openAppearance() {
    const card = document.getElementById("appearanceCard");
    if (card) {
      if (typeof window.showOptTab === "function") window.showOptTab("general");
      setTimeout(() => { try { card.scrollIntoView({ behavior: "smooth", block: "start" }); } catch (e) { card.scrollIntoView(); } }, 60);
      return;
    }
    try { chrome.tabs.create({ url: chrome.runtime.getURL("options.html?appearance=1#general") }); } catch (e) {}
  }
  let lastWall = { ...WALL_DEF }, lastImg = "";
  function paintAppearance(w, img) {
    lastWall = w; lastImg = img;
    const c = document.getElementById("appearanceCard");
    if (!c) return;
    const $c = (id) => document.getElementById(id);
    if ($c("apWallFit")) $c("apWallFit").value = w.fit === "contain" ? "contain" : "cover";
    if ($c("apWallDim")) $c("apWallDim").value = String(w.dim != null ? w.dim : 35);
    if ($c("apWallBlur")) $c("apWallBlur").value = String(w.blur || 0);
    if ($c("apWallGlass")) $c("apWallGlass").checked = w.glass !== false;
    if ($c("apWallPopup")) $c("apWallPopup").checked = w.popup !== false;
    const any = !!img || !!vidMeta;
    if ($c("apWallRemove")) $c("apWallRemove").hidden = !any;
    if ($c("apWallThumb")) {
      const th = $c("apWallThumb");
      th.style.backgroundImage = img && !vidMeta ? 'url("' + img + '")' : "";
      th.textContent = vidMeta ? (vidMeta.kind === "video" ? "\uD83C\uDFAC" : "GIF") : "";
      th.title = vidMeta ? vidMeta.name + " (" + sizeText(vidMeta.size) + ")" : "";
      th.hidden = !any;
    }
    c.querySelectorAll("[data-wall-on]").forEach((el) => { el.hidden = !any; });
    c.querySelectorAll('input[name="apScene"]').forEach((r) => { r.checked = r.value === scene; });
    c.querySelectorAll("[data-scene-weather]").forEach((el) => { el.hidden = scene !== "weather"; });
    c.querySelectorAll("[data-scene-any]").forEach((el) => { el.hidden = scene === "plain"; });
  }
  function wireAppearance() {
    const c = document.getElementById("appearanceCard");
    if (!c || c._wired) return;
    c._wired = true;
    const $c = (id) => document.getElementById(id);
    const say = (t, bad) => { const m = $c("apMsg"); if (m) { m.textContent = t || ""; m.style.color = bad ? "var(--red)" : ""; } };
    // Your own palettes: three colour boxes per mode, live while you pick.
    for (const m of ["light", "dark"]) {
      const key = m === "light" ? "themeCustomLight" : "themeCustomDark";
      const ins = ["bg", "card", "accent"].map((f) => $c("apC_" + m + "_" + f));
      const fill = () => { const v = customs[m] || CUSTOM_DEFAULT[m]; ins.forEach((el, i) => { if (el && document.activeElement !== el) el.value = v[["bg", "card", "accent"][i]]; }); };
      fill();
      apRefills.push(fill);
      let t = 0;
      const save = (use) => {
        const v = { bg: ins[0].value, card: ins[1].value, accent: ins[2].value };
        customs[m] = v; paintCustomCss();
        clearTimeout(t);
        t = setTimeout(() => {
          const patch = { [key]: v };
          if (use) { patch[m === "light" ? "themePaletteLight" : "themePaletteDark"] = "custom"; patch.theme = m; }
          chrome.storage.local.set(patch).catch(() => {});
          if (use) { root.dataset[m === "light" ? "palLight" : "palDark"] = "custom"; if (typeof window.applyTheme === "function") window.applyTheme(m); else root.dataset.theme = m; }
        }, use ? 0 : 150);
      };
      ins.forEach((el) => el && el.addEventListener("input", () => save(true)));
      const reset = $c("apReset_" + m);
      if (reset) reset.onclick = async () => {
        customs[m] = null; paintCustomCss();
        const pk = m === "light" ? "themePaletteLight" : "themePaletteDark";
        const g = await chrome.storage.local.get(pk).catch(() => ({}));
        const patch = { [key]: null };
        if (g && g[pk] === "custom") patch[pk] = "classic";
        await chrome.storage.local.set(patch).catch(() => {});
        fill();
        say(m === "light" ? "Light palette back to Classic." : "Dark palette back to Classic.");
      };
      const use = $c("apUse_" + m);
      if (use) use.onclick = () => { save(true); say("Your " + m + " palette is on."); };
    }
    // Your saved looks (palette + wallpaper), with Save this look…
    wireLooks(c, say);
    // Wallpaper.
    const setWall = (patch) => { const w = { ...lastWall, ...patch }; lastWall = w; paintWall(w, lastImg); chrome.storage.local.set({ themeWall: w }).catch(() => {}); };
    if ($c("apWallPick")) $c("apWallPick").onclick = () => $c("apWallFile") && $c("apWallFile").click();
    c.querySelectorAll('input[name="apScene"]').forEach((r) => { r.onchange = async () => {
      if (!r.checked) return;
      if (r.value === "wall" && !lastImg && !vidMeta) { say("Choose a picture or a video below first."); $c("apWallFile") && $c("apWallFile").click(); paintAppearance(lastWall, lastImg); return; }
      await setScene(r.value);
      say(r.value === "weather" ? "Task weather is on - it follows the running task." : r.value === "plain" ? "Plain background." : "Your wallpaper is on.");
    }; });
    // Preview every stage of the weather without a timer (this page only).
    const prev = $c("apWxPrev"), prevTxt = $c("apWxPrevTxt");
    const showPrev = () => { if (prevTxt && window.PcmWeather) prevTxt.textContent = window.PcmWeather.forecast().text; };
    // ▶ Play: the whole cycle as a demo - the night, clouds rolling in to the
    // snowy start, 0% → 250% of the estimate in about 30 s (the slider follows),
    // a moment at the volcano, then clouds again back to the night. ❚❚ Pause
    // stops where it is; Play goes on from there (or from the slider).
    const play = $c("apWxPlay");
    let demo = null, demoTimer = 0;
    const DEMO = { night: 25, into: 55, rampTicks: 300, hold: 30, out: 60 }; // ticks of 100 ms
    const playLabel = (on) => { if (play) { play.textContent = on ? "❚❚ Pause" : "▶ Play"; play.setAttribute("aria-pressed", on ? "true" : "false"); } };
    const pausePlay = () => { clearInterval(demoTimer); demoTimer = 0; playLabel(false); };
    const tick = () => {
      const W = window.PcmWeather;
      if (!W || !demo) { pausePlay(); return; }
      if (demo.n > 0) { demo.n--; return; }
      if (demo.phase === "night") { demo.phase = "into"; demo.n = DEMO.into; demo.at = 0; W.preview(0); }
      else if (demo.phase === "into") { demo.phase = "ramp"; }
      else if (demo.phase === "ramp") {
        demo.at = Math.min(250, demo.at + 250 / DEMO.rampTicks);
        W.preview(demo.at / 100);
        if (demo.at >= 250) { demo.phase = "hold"; demo.n = DEMO.hold; }
      } else if (demo.phase === "hold") { demo.phase = "out"; demo.n = DEMO.out; W.preview("night"); }
      else { demo = null; pausePlay(); if (prev) prev.value = "0"; showPrev(); return; } // done: resting on the night
      if (prev && demo) prev.value = String(Math.round(demo.at || 0));
      showPrev();
    };
    if (play) play.onclick = () => {
      const W = window.PcmWeather;
      if (!W) return;
      if (demoTimer) { pausePlay(); return; }
      if (!demo) {
        const v = prev ? Number(prev.value) || 0 : 0;
        demo = v > 0 && v < 250 ? { phase: "ramp", n: 0, at: v } : { phase: "night", n: DEMO.night, at: 0 };
        if (demo.phase === "night") W.preview("night"); else W.preview(v / 100);
        showPrev();
      }
      playLabel(true);
      demoTimer = setInterval(tick, 100);
    };
    if (prev) prev.oninput = () => { if (window.PcmWeather) { pausePlay(); demo = { phase: "ramp", n: 0, at: Number(prev.value) || 0 }; window.PcmWeather.preview(Number(prev.value) / 100); showPrev(); } };
    const solid = $c("apCardSolid");
    if (solid) { solid.value = String(cardSolid); solid.oninput = () => setCards(Number(solid.value)); }
    const strg = $c("apWxStrength");
    if (strg && window.PcmWeather) {
      strg.value = String(window.PcmWeather.strength);
      apRefills.push(() => { if (document.activeElement !== strg) strg.value = String(window.PcmWeather.strength); });
      strg.oninput = () => window.PcmWeather.setStrength(Number(strg.value));
      try { chrome.storage.onChanged.addListener((ch, area) => { if (area === "local" && ch.themeWeather && document.activeElement !== strg) strg.value = String(window.PcmWeather.strength); }); } catch (e) {}
    }
    if ($c("apWxLive")) $c("apWxLive").onclick = () => { pausePlay(); demo = null; if (prev) prev.value = "0"; if (window.PcmWeather) { window.PcmWeather.preview(null); showPrev(); } };
    if ($c("apWallFile")) $c("apWallFile").onchange = async () => {
      const f = $c("apWallFile").files && $c("apWallFile").files[0];
      $c("apWallFile").value = "";
      if (!f) return;
      // A video or an animated GIF: kept as it is (in IndexedDB) so it moves.
      if (/^video\/(mp4|webm|ogg)$/.test(f.type || "") || f.type === "image/gif") {
        if (f.size > 200 * 1048576) { say("That file is " + Math.round(f.size / 1048576) + " MB - choose one under 200 MB (a short loop is plenty).", true); return; }
        say("Saving the " + (f.type === "image/gif" ? "GIF" : "video") + "…");
        try {
          await idbPut("wall", f);
          vidMeta = { kind: f.type === "image/gif" ? "gif" : "video", name: f.name || "wallpaper", size: f.size, type: f.type, at: Date.now() };
          await chrome.storage.local.set({ themeWallVideo: vidMeta, themeWall: { ...lastWall }, themeScene: "wall" });
          await chrome.storage.local.remove("themeWallImg").catch(() => {});
          lastImg = ""; scene = "wall";
          paintWall(lastWall, ""); paintAppearance(lastWall, "");
          say((vidMeta.kind === "gif" ? "Moving GIF" : "Video") + " wallpaper set (" + sizeText(f.size) + ") - it plays muted on a loop and pauses when the page is hidden.");
        } catch (e) { say("Couldn't keep that file: " + ((e && e.message) || e), true); }
        return;
      }
      if (!/^image\//.test(f.type || "")) { say("Choose a picture (JPG, PNG, WebP, GIF) or a video (MP4, WebM).", true); return; }
      say("Getting the picture ready…");
      try {
        const r = await shrinkImage(f);
        if (vidMeta) { await idbDel("wall").catch(() => {}); vidMeta = null; await chrome.storage.local.remove("themeWallVideo").catch(() => {}); }
        await chrome.storage.local.set({ themeWallImg: r.data, themeWall: { ...lastWall }, themeScene: "wall" });
        scene = "wall";
        lastImg = r.data;
        paintWall(lastWall, lastImg); paintAppearance(lastWall, lastImg);
        say("Wallpaper set (" + r.src[0] + "×" + r.src[1] + (r.w && (r.w !== r.src[0]) ? ", shrunk to " + r.w + "×" + r.h : "") + ", " + Math.round(r.data.length * 0.75 / 1024) + " KB). It fills any screen size.");
      } catch (e) { say("Couldn't use that picture: " + ((e && e.message) || e), true); }
    };
    if ($c("apWallRemove")) $c("apWallRemove").onclick = async () => {
      await chrome.storage.local.remove(["themeWallImg", "themeWallVideo"]).catch(() => {});
      if (vidMeta) { await idbDel("wall").catch(() => {}); vidMeta = null; }
      lastImg = "";
      if (scene === "wall") { scene = "plain"; await chrome.storage.local.set({ themeScene: "plain" }).catch(() => {}); }
      paintWall(lastWall, ""); paintAppearance(lastWall, "");
      say("Wallpaper removed - back to the plain background.");
    };
    if ($c("apWallFit")) $c("apWallFit").onchange = () => setWall({ fit: $c("apWallFit").value });
    if ($c("apWallDim")) $c("apWallDim").oninput = () => setWall({ dim: Number($c("apWallDim").value) });
    if ($c("apWallBlur")) $c("apWallBlur").oninput = () => setWall({ blur: Number($c("apWallBlur").value) });
    if ($c("apWallGlass")) $c("apWallGlass").onchange = () => setWall({ glass: $c("apWallGlass").checked });
    if ($c("apWallPopup")) $c("apWallPopup").onchange = () => setWall({ popup: $c("apWallPopup").checked });
    paintAppearance(lastWall, lastImg);
    if (/[?&]appearance=1/.test(location.search)) setTimeout(openAppearance, 500);
  }
  loadWall();
  window.PcmTheme = { deriveCustom, contrastOf, openAppearance };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", wireAppearance); else wireAppearance();

  apply();
  hookTheme();
  // Some buttons arrive a moment later (reminders, notifications, search).
  const host = document.querySelector(".header .header-actions") || document.querySelector(".hdr-tools") || document.body;
  const mo = new MutationObserver(() => { apply(); hookTheme(); });
  mo.observe(host, { childList: true, subtree: true });
  setTimeout(() => mo.disconnect(), 8000);
  document.addEventListener("DOMContentLoaded", () => { apply(); hookTheme(); });
})();

// "Loading…", "Syncing…", "Refreshing…" messages that can't be missed. They used
// to be plain grey text: after a click (a day in the calendar) the list read
// "Loading tasks for these dates…" so quietly that people thought nothing was
// happening and left. Any such message - a line of its own - becomes a tinted box
// with a spinner; a label that merely ends in "(loading…)" gets a spinner pill.
// Buttons, inputs and menus are left alone (they say "Moving…" in their own way).
(() => {
  "use strict";
  const MSG_RE = /^(loading|syncing|refreshing|reading|saving|fetching|indexing|building|checking|asking|waiting for|updating|looking|working out|getting|downloading)\b[^\n]{0,140}(…|\.\.\.)\s*$/i;
  const TAIL_RE = /\((loading|refreshing|syncing)…\)\s*$|· (refreshing|syncing|loading)…\s*$/i;
  const css = document.createElement("style");
  css.textContent = `
    .pcm-busy { display: flex !important; align-items: center; gap: 9px; width: fit-content; max-width: 100%; box-sizing: border-box; margin: 6px 0; padding: 8px 14px !important; border-radius: 9px; background: rgba(99, 102, 241, .12); border: 1px solid rgba(99, 102, 241, .45); color: var(--indigo, #4f46e5) !important; font-weight: 600 !important; font-size: 13px; animation: pcmBusyPulse 1.6s ease-in-out infinite; }
    .pcm-busy::before, .pcm-busy-tail::after { content: ""; flex: none; width: 12px; height: 12px; border: 2px solid currentColor; border-right-color: transparent; border-radius: 50%; animation: pcmBusySpin .7s linear infinite; }
    .pcm-busy-tail { color: var(--indigo, #4f46e5) !important; font-weight: 600; }
    .pcm-busy-tail::after { display: inline-block; width: 9px; height: 9px; margin-left: 6px; vertical-align: -1px; }
    .ins-empty.pcm-busy, .dash-empty.pcm-busy { margin: 10px auto; }
    @keyframes pcmBusySpin { to { transform: rotate(360deg); } }
    @keyframes pcmBusyPulse { 0%, 100% { box-shadow: 0 0 0 0 rgba(99, 102, 241, .0); } 50% { box-shadow: 0 0 0 4px rgba(99, 102, 241, .18); } }
    @media (prefers-reduced-motion: reduce) { .pcm-busy { animation: none; } .pcm-busy::before, .pcm-busy-tail::after { animation-duration: 2s; } }
  `;
  (document.head || document.documentElement).appendChild(css);
  const SKIP = "button, input, select, option, textarea, a, label, .xt, .au-term, .cu-rollpop, [contenteditable=true], .pcs-box, .cu-task, header, .header, .chips, .status-chips, .drivesync, .drivesync-row, [class*=chip], [class*=dot]";
  // A line of its own: it spans (nearly) the width it has, i.e. it is not one
  // label among others in a row - those keep their own look.
  function wideLine(el) {
    const p = el.parentElement;
    if (!p) return false;
    // Measured only before the box is on: the box itself is fit-content, so
    // measuring it again would take it off, widen the line, put it back on... -
    // a flicker of its own.
    if (!el.classList.contains("pcm-busy")) {
      const pw = p.clientWidth || 0, w = el.getBoundingClientRect().width || 0;
      if (pw && w < pw * 0.6) return false;
    }
    const pd = getComputedStyle(p).display;
    if (/flex|grid/.test(pd) && [...p.children].filter((c) => c !== el && c.offsetParent !== null).length) return false;
    return true;
  }
  function check(el) {
    if (!el || el.nodeType !== 1 || !el.isConnected) return;
    if (el.closest(SKIP)) { el.classList.remove("pcm-busy", "pcm-busy-tail"); return; }
    // Only a line of its own: no element children (a spinner span is fine).
    const kids = [...el.children].filter((c) => !c.classList.contains("cu-spin") && !c.classList.contains("cu-spinner"));
    const t = kids.length ? "" : (el.textContent || "").trim();
    const big = !!t && MSG_RE.test(t) && /^(DIV|P)$/.test(el.tagName) && el.offsetParent !== null && wideLine(el);
    const tail = !big && !!t && TAIL_RE.test(t);
    if (el.classList.contains("pcm-busy") !== big) el.classList.toggle("pcm-busy", big);
    if (el.classList.contains("pcm-busy-tail") !== tail) el.classList.toggle("pcm-busy-tail", tail);
  }
  const scan = (root) => {
    if (!root || root.nodeType !== 1) return;
    check(root);
    root.querySelectorAll("div, p, span, small, em, li, td").forEach(check);
  };
  let todo = new Set(), timer = 0;
  const flush = () => { timer = 0; const list = [...todo]; todo = new Set(); for (const n of list) scan(n); };
  new MutationObserver((recs) => {
    for (const r of recs) {
      const n = r.type === "characterData" ? r.target.parentElement : r.target;
      if (n && n.nodeType === 1) todo.add(n);
      for (const a of r.addedNodes || []) if (a.nodeType === 1) todo.add(a);
    }
    if (!timer) timer = setTimeout(flush, 60);
  }).observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  const first = () => scan(document.body);
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", first); else first();
})();
