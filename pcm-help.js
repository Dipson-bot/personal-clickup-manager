// Help for the popup, side panel, options and update pages:
//  - keeps the last few page errors (for "Copy diagnostics"),
//  - the setup checklist ("Setup: 3 of 5 done") for new teammates,
//  - window.PcmHelp.copyDiagnostics(): a readable report with no tokens,
//    emails, links or IDs (the background builds and scrubs it).
(() => {
  "use strict";
  const page = (location.pathname.split("/").pop() || "page").replace(/\.html$/, "") + (/view=panel/.test(location.search) ? " (side panel)" : "");

  // ---- page errors -> storage (last 25, shared with the background's) ----
  function logErr(msg) {
    try {
      chrome.storage.local.get("diagLog").then((g) => {
        const log = Array.isArray(g && g.diagLog) ? g.diagLog : [];
        log.push({ at: Date.now(), where: page, msg: String(msg).slice(0, 300) });
        return chrome.storage.local.set({ diagLog: log.slice(-25) });
      }).catch(() => {});
    } catch (e) {}
  }
  window.addEventListener("error", (e) => logErr((e.message || "error") + (e.filename ? " (" + e.filename.split("/").pop() + ":" + e.lineno + ")" : "")));
  window.addEventListener("unhandledrejection", (e) => logErr("promise: " + ((e.reason && e.reason.message) || e.reason)));

  if (page.startsWith("update")) return; // the update page only needs the error log

  const send = (msg) => new Promise((res) => {
    try { chrome.runtime.sendMessage(msg, (r) => { void chrome.runtime.lastError; res(r || null); }); } catch (e) { res(null); }
  });
  const isOptions = !!document.querySelector('.panel[data-panel="dashboard"]');
  const optionsUrl = (hash) => chrome.runtime.getURL("options.html") + "#" + hash;
  // Open an options section (and point at a card on it).
  function goTo(hash, cardId) {
    if (isOptions) {
      location.hash = "#" + hash;
      setTimeout(() => {
        const el = cardId && document.getElementById(cardId);
        if (!el) return;
        el.scrollIntoView({ block: "center", behavior: "smooth" });
        el.classList.add("pcm-flash");
        setTimeout(() => el.classList.remove("pcm-flash"), 1600);
      }, 60);
    } else {
      chrome.tabs.create({ url: optionsUrl(hash) }).catch(() => {});
      window.close();
    }
  }

  // ---- setup checklist ----
  async function updateFolderReady() {
    try {
      const { kvGet } = await import(chrome.runtime.getURL("lib-updater.js"));
      const h = await kvGet("extDir");
      if (!h || !h.queryPermission) return false;
      return (await h.queryPermission({ mode: "readwrite" })) === "granted";
    } catch (e) {
      return false;
    }
  }
  async function checks() {
    const st = (await send({ type: "GET_STATE" })) || {};
    const settings = st.settings || {};
    const cu = st.clickup || {};
    let notifyLevel = "granted";
    try { notifyLevel = await new Promise((r) => chrome.notifications.getPermissionLevel(r)); } catch (e) {}
    let pinned = true;
    try { pinned = !!(await chrome.action.getUserSettings()).isOnToolbar; } catch (e) {}
    const autoOff = settings.autoUpdate === false;
    const folder = autoOff ? true : await updateFolderReady();
    return [
      { id: "clickup", label: "Connect ClickUp", done: !!(cu.configured && cu.teamId),
        hint: "Your tasks, estimates and timers come from ClickUp.", btn: "Connect", run: () => goTo("clickup") },
      { id: "drive", label: "Turn on Drive sync", done: !!st.signedIn,
        hint: "Keeps your settings and site list safe if you reinstall or use another computer.", btn: "Sign in", run: () => goTo("general", "driveSyncCard") },
      { id: "updates", label: "Set up automatic updates", done: folder,
        hint: autoOff ? "" : "Choose the extension's folder once and pick \"Allow on every visit\" when Chrome asks.", btn: "Set up",
        run: () => chrome.tabs.create({ url: chrome.runtime.getURL("update.html?setup=1") }).catch(() => {}) },
      { id: "notify", label: "Allow notifications", done: notifyLevel === "granted",
        hint: "Chrome is blocking this extension's notifications. Windows: Settings > System > Notifications > turn on Google Chrome. Mac: System Settings > Notifications > Google Chrome." },
      { id: "pin", label: "Pin the extension to the toolbar", done: pinned,
        hint: "Click the puzzle-piece icon at the top right of Chrome, then the pin next to Personal ClickUp Manager." },
    ];
  }

  const css = document.createElement("style");
  css.textContent = `
    .pcm-setup { border: 1px solid var(--indigo, #6366f1); }
    .pcm-setup h2 { display: flex; align-items: center; gap: 8px; }
    .pcm-setup h2 .pcm-hide { margin-left: auto; font: inherit; font-size: 11.5px; font-weight: 400; background: none; border: 0; color: var(--muted); cursor: pointer; padding: 2px 4px; }
    .pcm-setup-bar { height: 6px; border-radius: 999px; background: var(--bg2); overflow: hidden; margin: 0 0 10px; }
    .pcm-setup-bar i { display: block; height: 100%; background: var(--indigo, #6366f1); border-radius: 999px; }
    .pcm-step { display: flex; align-items: flex-start; gap: 10px; padding: 7px 0; border-top: 1px solid var(--border); }
    .pcm-step:first-of-type { border-top: 0; }
    .pcm-step .ic { flex: none; width: 18px; height: 18px; border-radius: 50%; display: grid; place-items: center; font-size: 11px; margin-top: 1px;
      border: 1.5px solid var(--border); color: transparent; }
    .pcm-step.done .ic { background: var(--green); border-color: var(--green); color: #fff; }
    .pcm-step .tx { flex: 1; min-width: 0; font-size: 13px; }
    .pcm-step.done .tx b { color: var(--muted); font-weight: 500; text-decoration: line-through; }
    .pcm-step .tx .hint { display: block; margin-top: 2px; line-height: 1.45; }
    .pcm-step button { flex: none; }
    .pcm-setupline { display: flex; align-items: center; gap: 8px; margin: 0 0 8px; padding: 7px 10px; border-radius: 8px; font-size: 12px;
      background: var(--bg2); border: 1px solid var(--border); cursor: pointer; }
    .pcm-setupline b { color: var(--indigo, #6366f1); }
    .pcm-setupline span { margin-left: auto; color: var(--indigo, #6366f1); font-weight: 600; }
    .pcm-flash { animation: pcm-flash 1.6s ease; }
    @keyframes pcm-flash { 0%, 60% { box-shadow: 0 0 0 3px var(--indigo, #6366f1); } 100% { box-shadow: none; } }
  `;
  document.head.appendChild(css);

  let box = null;
  async function render() {
    const { setupHidden } = await chrome.storage.local.get("setupHidden").catch(() => ({}));
    const items = await checks();
    const done = items.filter((i) => i.done).length;
    const complete = done === items.length;
    if (setupHidden || complete) { if (box) { box.remove(); box = null; } return; }
    if (isOptions) {
      const panel = document.querySelector('.panel[data-panel="dashboard"]');
      if (!panel) return;
      if (!box) { box = document.createElement("div"); box.className = "card pcm-setup"; panel.prepend(box); }
      box.replaceChildren();
      const h = document.createElement("h2");
      h.textContent = "Setup: " + done + " of " + items.length + " done";
      const hide = document.createElement("button");
      hide.type = "button"; hide.className = "pcm-hide"; hide.textContent = "Hide";
      hide.title = "Hide this checklist (bring it back from General > Help & diagnostics)";
      hide.onclick = () => chrome.storage.local.set({ setupHidden: true });
      h.appendChild(hide);
      const bar = document.createElement("div");
      bar.className = "pcm-setup-bar";
      bar.innerHTML = "<i></i>";
      bar.firstChild.style.width = Math.round((done / items.length) * 100) + "%";
      box.append(h, bar);
      for (const it of items) {
        const row = document.createElement("div");
        row.className = "pcm-step" + (it.done ? " done" : "");
        const ic = document.createElement("span"); ic.className = "ic"; ic.textContent = "✓";
        const tx = document.createElement("div"); tx.className = "tx";
        const b = document.createElement("b"); b.textContent = it.label;
        tx.appendChild(b);
        if (!it.done && it.hint) { const s = document.createElement("span"); s.className = "hint"; s.textContent = it.hint; tx.appendChild(s); }
        row.append(ic, tx);
        if (!it.done && it.run) { const bt = document.createElement("button"); bt.type = "button"; bt.textContent = it.btn; bt.onclick = it.run; row.appendChild(bt); }
        box.appendChild(row);
      }
    } else {
      const header = document.querySelector(".header");
      if (!header) return;
      if (!box) { box = document.createElement("div"); box.className = "pcm-setupline"; header.after(box); box.onclick = () => goTo("dashboard"); }
      const next = items.find((i) => !i.done);
      box.innerHTML = "";
      const b = document.createElement("b"); b.textContent = "Setup " + done + " of " + items.length;
      const t = document.createElement("em"); t.style.fontStyle = "normal"; t.textContent = "Next: " + next.label.toLowerCase();
      const go = document.createElement("span"); go.textContent = "Finish →";
      box.append(b, t, go);
    }
  }
  let timer = null;
  const soon = () => { clearTimeout(timer); timer = setTimeout(() => render().catch(() => {}), 400); };
  soon();
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") soon(); });
  window.addEventListener("focus", soon);
  chrome.storage.onChanged.addListener((ch, area) => {
    if (area === "local" && (ch.setupHidden || ch.clickupEnc || ch.driveLastSync || ch.settings)) soon();
  });

  // ---- diagnostics ----
  async function copyDiagnostics() {
    const ua = navigator.userAgentData;
    let browser = navigator.userAgent;
    try {
      if (navigator.brave && (await navigator.brave.isBrave())) browser = "Brave · " + browser;
      else if (/Edg\//.test(browser)) browser = "Edge · " + browser;
    } catch (e) {}
    const items = await checks().catch(() => []);
    const r = await send({
      type: "DIAG_REPORT",
      page: {
        browser, platform: (ua && ua.platform) || navigator.platform || "", language: navigator.language,
        folderPicker: typeof window.showDirectoryPicker === "function",
        setup: items.map((i) => (i.done ? "[x] " : "[ ] ") + i.label),
      },
    });
    if (!r || !r.ok) throw new Error((r && r.error) || "the extension didn't answer - reload it and try again");
    await navigator.clipboard.writeText(r.text);
    return r.text;
  }
  window.PcmHelp = { copyDiagnostics, refreshSetup: soon, showSetup: () => chrome.storage.local.set({ setupHidden: false }) };
})();
