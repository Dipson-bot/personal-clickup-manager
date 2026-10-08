// Help & issues (Options > Help & issues) and Admin > Team hub.
// Talks to the admin's Google Apps Script through the background ("HUB"
// messages), which adds this install's id, the ClickUp name/photo and, for the
// admin, the admin key. Names and photos come only from ClickUp.
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const send = (msg) => new Promise((res) => { try { chrome.runtime.sendMessage(msg, (r) => { void chrome.runtime.lastError; res(r || { ok: false, error: "No answer from the extension." }); }); } catch (e) { res({ ok: false, error: String(e) }); } });
  const hub = (action, payload, admin) => send({ type: "HUB", action, payload: payload || {}, admin: !!admin });
  const VERSION = chrome.runtime.getManifest().version;
  const cmpV = (a, b) => { const x = String(a).split(".").map(Number), y = String(b).split(".").map(Number); for (let i = 0; i < 4; i++) { const d = (x[i] || 0) - (y[i] || 0); if (d) return d; } return 0; };
  const ago = (ms) => { const s = Math.max(0, (Date.now() - ms) / 1000); if (s < 60) return "just now"; if (s < 3600) return Math.round(s / 60) + " min ago"; if (s < 86400) return Math.round(s / 3600) + " h ago"; if (s < 7 * 86400) return Math.round(s / 86400) + " d ago"; return new Date(ms).toLocaleDateString([], { month: "short", day: "numeric" }); };
  const MAX_FILES = 8, MAX_TOTAL = 20 * 1048576;

  const css = document.createElement("style");
  css.textContent = `
    .hb-bar { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin: 4px 0 10px; }
    .hb-bar input[type=search] { flex: 1; min-width: 180px; }
    .hb-chip { font: inherit; font-size: 12px; padding: 3px 10px; border-radius: 99px; border: 1px solid var(--border); background: var(--bg2); color: var(--text); cursor: pointer; }
    .hb-chip.on { border-color: var(--indigo); color: var(--indigo); background: rgba(99,102,241,.12); }
    .hb-row { display: flex; gap: 10px; align-items: flex-start; padding: 9px 6px; border-top: 1px solid var(--border); cursor: pointer; border-radius: 8px; }
    .hb-row:hover { background: var(--bg2); }
    .hb-dot { width: 9px; height: 9px; border-radius: 50%; margin-top: 5px; flex: none; background: #f59e0b; }
    .hb-dot.resolved { background: #16a34a; }
    .hb-row .hb-t { flex: 1; min-width: 0; }
    .hb-row .hb-title { font-weight: 600; overflow-wrap: anywhere; }
    .hb-sub { font-size: 11.5px; color: var(--muted); margin-top: 2px; display: flex; flex-wrap: wrap; gap: 4px 10px; }
    .hb-badge { font-size: 10.5px; font-weight: 700; padding: 1px 7px; border-radius: 99px; background: rgba(22,163,74,.14); color: #16a34a; }
    .hb-badge.admin { background: rgba(99,102,241,.14); color: var(--indigo); }
    .hb-badge.warn { background: rgba(245,158,11,.16); color: #b45309; }
    .hb-empty { color: var(--muted); font-style: italic; padding: 10px 4px; }
    .hb-form { display: flex; flex-direction: column; gap: 8px; padding: 10px; border: 1px solid var(--border); border-radius: 10px; margin: 6px 0 12px; background: var(--card); }
    .hb-form textarea { min-height: 90px; resize: vertical; font: inherit; }
    .hb-form.over, .hb-reply.over { outline: 2px dashed var(--indigo); outline-offset: 3px; }
    .hb-files { display: flex; flex-wrap: wrap; gap: 5px; }
    .hb-file { display: inline-flex; align-items: center; gap: 4px; font-size: 11.5px; padding: 2px 4px 2px 8px; border: 1px solid var(--border); border-radius: 99px; background: var(--bg2); max-width: 100%; }
    .hb-file span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 180px; }
    .hb-file button { border: 0; background: none; color: var(--muted); cursor: pointer; padding: 0 3px; }
    .hb-foot { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .hb-foot .hb-msg { flex: 1; font-size: 12px; color: var(--muted); }
    .hb-msg.err { color: var(--red, #dc2626); }
    .hb-similar { font-size: 12px; }
    .hb-similar .hb-row { padding: 5px 6px; }
    .hb-head { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-bottom: 6px; }
    .hb-head h3 { margin: 0; font-size: 15px; flex: 1; min-width: 200px; overflow-wrap: anywhere; }
    .hb-acts { display: flex; gap: 6px; flex-wrap: wrap; margin: 6px 0 10px; }
    .hb-acts button, .hb-mini { font: inherit; font-size: 11.5px; padding: 3px 9px; border-radius: 7px; border: 1px solid var(--border); background: var(--bg2); color: var(--text); cursor: pointer; }
    .hb-role { font-size: 11.5px; color: var(--muted); }
    .hb-role.adm { color: var(--indigo, #6366f1); font-weight: 700; }
    .hb-rolesel { font: inherit; font-size: 11.5px; padding: 2px 6px; width: auto; }
    .hb-msgs { display: flex; flex-direction: column; gap: 12px; margin: 8px 0 12px; }
    .hb-m { display: flex; gap: 10px; }
    .hb-av { width: 30px; height: 30px; border-radius: 50%; flex: none; object-fit: cover; display: grid; place-items: center; font: 700 11px sans-serif; color: #fff; background: #6366f1; overflow: hidden; }
    .hb-m .hb-b { flex: 1; min-width: 0; }
    .hb-m .hb-who { font-size: 12px; display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
    .hb-m .hb-who b { font-weight: 700; }
    .hb-m .hb-who span { color: var(--muted); font-size: 11px; }
    .hb-m .hb-text { white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.5; margin-top: 2px; }
    .hb-m .hb-text a { color: var(--indigo); }
    .hb-m.admin .hb-b { background: rgba(99,102,241,.07); border-radius: 8px; padding: 6px 8px; }
    .hb-thumbs { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 6px; }
    .hb-thumbs img { max-width: 220px; max-height: 160px; border-radius: 6px; border: 1px solid var(--border); }
    .hb-m .hb-ops { display: flex; gap: 6px; margin-top: 4px; flex-wrap: wrap; }
    .hb-m .hb-ops button { font: inherit; font-size: 11px; border: 0; background: none; color: var(--muted); cursor: pointer; padding: 0; text-decoration: underline; }
    .hb-reply { display: flex; flex-direction: column; gap: 6px; }
    .hb-reply textarea { min-height: 70px; resize: vertical; font: inherit; }
    .hb-users { width: 100%; border-collapse: collapse; font-size: 12.5px; margin-top: 8px; }
    .hb-users td, .hb-users th { padding: 6px 6px; border-top: 1px solid var(--border); text-align: left; vertical-align: middle; }
    .hb-users th { font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: .04em; border-top: 0; }
    .hb-stats { display: flex; gap: 14px; flex-wrap: wrap; margin: 6px 0; font-size: 13px; }
    .hb-stats b { font-size: 18px; margin-right: 4px; }
    .hb-quote { font-size: 11.5px; color: var(--muted); border-left: 3px solid var(--border); padding: 2px 8px; margin: 3px 0; overflow: hidden; text-overflow: ellipsis; }
    .hb-quote b { color: var(--text); font-weight: 600; }
    .hb-rx { display: flex; gap: 5px; flex-wrap: wrap; align-items: center; margin-top: 5px; }
    .hb-rxc { font: inherit; font-size: 12px; padding: 1px 8px; border-radius: 99px; border: 1px solid var(--border); background: var(--bg2); color: var(--text); cursor: pointer; }
    .hb-rxc.on { border-color: var(--indigo); background: rgba(99,102,241,.14); }
    .hb-rxc.add { color: var(--muted); }
    .hb-rxpick { display: inline-flex; gap: 2px; padding: 2px 4px; border: 1px solid var(--border); border-radius: 99px; background: var(--card); }
    .hb-rxpick button { border: 0; background: none; font-size: 15px; cursor: pointer; padding: 1px 3px; border-radius: 6px; }
    .hb-rxpick button:hover { background: var(--bg2); }
  `;
  document.head.appendChild(css);

  function avatar(p) {
    if (p && /^https:\/\//.test(p.avatar || "")) {
      const i = el("img", "hb-av"); i.src = p.avatar; i.alt = ""; i.referrerPolicy = "no-referrer";
      i.onerror = () => i.replaceWith(initialsAv(p));
      return i;
    }
    return initialsAv(p);
  }
  function initialsAv(p) {
    const d = el("div", "hb-av", String((p && (p.initials || p.name)) || "?").slice(0, 2).toUpperCase());
    if (p && /^#[0-9a-f]{3,8}$/i.test(p.color || "")) d.style.background = p.color;
    return d;
  }
  function linkify(node, text) {
    const re = /https?:\/\/[^\s<>"']+/g;
    let last = 0, m;
    while ((m = re.exec(text))) {
      node.append(text.slice(last, m.index));
      const a = el("a", "", m[0]); a.href = m[0]; a.target = "_blank"; a.rel = "noopener";
      node.appendChild(a);
      last = m.index + m[0].length;
    }
    node.append(text.slice(last));
  }
  // Screenshots / files for a post: paste, drop or 📎.
  function fileBox(root, onChange) {
    const files = [];
    const box = el("div", "hb-files");
    const inp = el("input"); inp.type = "file"; inp.multiple = true; inp.hidden = true;
    const add = el("button", "hb-mini", "📎 Attach"); add.type = "button";
    add.title = "Attach screenshots or files (or paste a screenshot with Ctrl+V, or drop files here)";
    const paint = () => {
      box.textContent = "";
      files.forEach((f, i) => {
        const c = el("span", "hb-file"); c.appendChild(el("span", "", f.name));
        const x = el("button", "", "✕"); x.type = "button"; x.onclick = () => { files.splice(i, 1); paint(); };
        c.appendChild(x); box.appendChild(c);
      });
      box.appendChild(add);
      if (onChange) onChange();
    };
    const take = (list, say) => {
      for (const f of [...list]) {
        if (files.length >= MAX_FILES) { say && say("Up to " + MAX_FILES + " files.", true); break; }
        if (files.reduce((n, x) => n + x.size, 0) + f.size > MAX_TOTAL) { say && say("Files are limited to 20 MB in total.", true); break; }
        const d = new Date(), p2 = (n) => String(n).padStart(2, "0");
        const name = f.name && f.name !== "image.png" ? f.name : "screenshot-" + d.getFullYear() + p2(d.getMonth() + 1) + p2(d.getDate()) + "-" + p2(d.getHours()) + p2(d.getMinutes()) + p2(d.getSeconds()) + ".png";
        files.push({ name, type: f.type || "application/octet-stream", size: f.size, file: f });
      }
      paint();
    };
    add.onclick = () => inp.click();
    inp.onchange = () => { take(inp.files || []); inp.value = ""; };
    root.addEventListener("paste", (e) => { const fl = [...((e.clipboardData && e.clipboardData.files) || [])]; if (fl.length) { e.preventDefault(); take(fl); } });
    root.addEventListener("dragover", (e) => { e.preventDefault(); root.classList.add("over"); });
    root.addEventListener("dragleave", () => root.classList.remove("over"));
    root.addEventListener("drop", (e) => { e.preventDefault(); root.classList.remove("over"); take((e.dataTransfer && e.dataTransfer.files) || []); });
    paint();
    const encode = () => Promise.all(files.map((f) => new Promise((ok) => { const r = new FileReader(); r.onload = () => ok({ name: f.name, type: f.type, b64: String(r.result || "").split(",")[1] || "" }); r.onerror = () => ok(null); r.readAsDataURL(f.file); }))).then((a) => a.filter(Boolean));
    return { box, input: inp, files, encode, clear: () => { files.length = 0; paint(); } };
  }

  // ---------- Help & issues tab ----------
  // What's on screen stays while fresh data loads ("Updating…" next to it);
  // only the parts that changed are redrawn, so the list never blinks and a
  // reply being typed is never lost.
  const REACTIONS = ["👍", "❤️", "😂", "🎉", "😮", "🙏", "✅", "👀"];
  let info = null, threads = null, filter = "open", openId = "", timer = null, adminMode = false;
  const cache = {}; // thread id -> { thread, messages }
  let view = null; // { kind: "list" | "thread", id, parts... }
  const panel = () => $("hubPanel");
  async function start() {
    if (!panel()) return;
    info = await send({ type: "HUB_INFO" });
    adminMode = !!(info && info.adminKey) && !document.body.classList.contains("no-admin");
    try { const t = new URLSearchParams(location.search).get("thread"); if (t) openId = t; } catch (e) {}
    view = null;
    render();
  }
  function render() {
    const root = panel();
    if (!root) return;
    if (!info || !info.url) {
      root.textContent = ""; view = null;
      root.appendChild(el("p", "hint", "Help & issues isn't set up yet. Your admin turns it on in Admin > Team hub; after that, this tab lists everyone's reported issues and lets you post your own."));
      return;
    }
    if (!info.profile) { root.textContent = ""; view = null; root.appendChild(el("p", "hint", "Connect ClickUp first (ClickUp setup): your name and photo here come from your ClickUp account.")); return; }
    if (openId) showThread(root); else showList(root);
  }
  const status = (t) => { if (view && view.status) view.status.textContent = t || ""; };

  // ----- list -----
  function showList(root) {
    if (!view || view.kind !== "list") {
      root.textContent = "";
      clearTimeout(timer);
      view = { kind: "list" };
      if (info.me && info.me.state === "banned") root.appendChild(el("p", "hb-msg err", "Your admin has turned off posting for this computer."));
      root.appendChild(el("p", "hint", "Report a problem or ask a question. Look first: someone may already have reported it - then press Me too and you'll be told when it's fixed. Your name and photo come from ClickUp; your admin also sees your extension version and when you last used it."));
      const bar = el("div", "hb-bar");
      const q = el("input"); q.type = "search"; q.placeholder = "Search issues…";
      bar.appendChild(q);
      const chips = [];
      for (const [k, l] of [["open", "Open"], ["resolved", "Resolved"], ["mine", "Mine"], ["all", "All"]]) {
        const c = el("button", "hb-chip" + (filter === k ? " on" : ""), l); c.type = "button";
        c.onclick = () => { filter = k; chips.forEach((x) => x.classList.toggle("on", x === c)); paintList(); };
        chips.push(c); bar.appendChild(c);
      }
      const nb = el("button", "primary", "+ New issue"); nb.type = "button";
      bar.appendChild(nb);
      const st = el("span", "hint"); st.style.marginLeft = "4px";
      bar.appendChild(st);
      root.appendChild(bar);
      const formBox = el("div"), listBox = el("div");
      root.append(formBox, listBox);
      Object.assign(view, { q, formBox, listBox, status: st });
      q.oninput = paintList;
      nb.onclick = () => { formBox.textContent = ""; formBox.appendChild(newIssueForm(q.value.trim(), () => { formBox.textContent = ""; })); };
    }
    paintList();
    refreshList();
  }
  async function refreshList() {
    status("Updating…");
    const r = await hub("threads", {}, adminMode);
    if (!view || view.kind !== "list") return;
    status("");
    if (r && r.ok) { threads = r.threads || []; paintList(); }
    else if (!threads) { view.listBox.textContent = ""; view.listBox.appendChild(el("div", "hb-msg err", (r && r.error) || "Couldn't load the issues.")); }
    else status("Couldn't refresh: " + ((r && r.error) || "no answer"));
  }
  function paintList() {
    if (!view || view.kind !== "list") return;
    const box = view.listBox;
    box.textContent = "";
    // Long lists: first 15, then "Show all" (long-list.js); the search is the one above.
    box.dataset.long = "hub-threads"; box.dataset.longRows = ".hb-row"; box.dataset.longMax = "15"; box.dataset.longNosearch = "1";
    if (!threads) { box.appendChild(el("div", "hb-empty", "Loading…")); return; }
    const words = view.q.value.toLowerCase().split(/\s+/).filter(Boolean);
    const rows = threads.filter((t) => (filter === "all" || (filter === "mine" ? t.mine : t.status === filter || (filter === "open" && t.pinned)))
      && words.every((w) => t.title.toLowerCase().includes(w)));
    if (!rows.length) box.appendChild(el("div", "hb-empty", words.length ? "Nothing matches - post it as a new issue." : filter === "open" ? "No open issues. 🎉" : "Nothing here yet."));
    rows.forEach((t) => box.appendChild(threadRow(t, false)));
  }
  function threadRow(t, compact) {
    const row = el("div", "hb-row");
    row.appendChild(el("span", "hb-dot" + (t.status === "resolved" ? " resolved" : "")));
    const tt = el("div", "hb-t");
    tt.appendChild(el("div", "hb-title", (t.pinned ? "📌 " : "") + (t.locked ? "🔒 " : "") + t.title));
    const sub = el("div", "hb-sub");
    sub.appendChild(el("span", "", "by " + (t.byName || "someone") + " · " + ago(t.createdAt)));
    sub.appendChild(el("span", "", t.count + " message" + (t.count === 1 ? "" : "s") + (t.metoo ? " · " + t.metoo + " also affected" : "")));
    if (t.status === "resolved") {
      sub.appendChild(el("span", "hb-badge", t.fixedIn ? "Fixed in v" + t.fixedIn : "Resolved"));
      if (t.fixedIn && cmpV(VERSION, t.fixedIn) >= 0) sub.appendChild(el("span", "hb-badge", "✓ Fixed in your version"));
      else if (t.fixedIn) sub.appendChild(el("span", "hb-badge warn", "Update to v" + t.fixedIn + " to get the fix"));
    }
    if (t.lastRole === "admin" && t.status !== "resolved") sub.appendChild(el("span", "hb-badge admin", "Admin replied"));
    tt.appendChild(sub);
    row.appendChild(tt);
    row.onclick = () => { openId = t.id; render(); };
    if (compact) {
      const me = el("button", "hb-mini", t.metooMine ? "✓ Me too" : "Me too");
      me.title = "Same problem? Add yourself instead of posting it again - you'll be told when it's fixed";
      me.onclick = async (e) => { e.stopPropagation(); me.disabled = true; const r = await hub("metoo", { id: t.id }); if (r && r.ok) { t.metooMine = r.mine; t.metoo = r.metoo; me.textContent = r.mine ? "✓ Me too" : "Me too"; } me.disabled = false; };
      row.appendChild(me);
    }
    return row;
  }
  function newIssueForm(title, onDone) {
    const f = el("form", "hb-form");
    const t = el("input"); t.type = "text"; t.maxLength = 150; t.placeholder = "Short title, e.g. \"Agent Router login keeps asking for the passkey\""; t.value = title || "";
    const similar = el("div", "hb-similar");
    const d = el("textarea"); d.maxLength = 4000; d.placeholder = "What happened? What did you expect? Paste screenshots with Ctrl+V or drop files here.";
    const fb = fileBox(f);
    const diagL = el("label"); diagL.style.cssText = "font-size:12px;display:flex;gap:6px;align-items:center;";
    const diag = el("input"); diag.type = "checkbox"; diag.checked = true;
    diagL.append(diag, "Include diagnostics (only the admin sees them; no passwords, tokens or client names)");
    const foot = el("div", "hb-foot");
    const msg = el("span", "hb-msg");
    const cancel = el("button", "hb-mini", "Cancel"); cancel.type = "button"; cancel.onclick = onDone;
    const post = el("button", "primary", "Post issue"); post.type = "submit";
    foot.append(msg, cancel, post);
    f.append(t, similar, d, fb.box, fb.input, diagL, foot);
    const showSimilar = () => {
      similar.textContent = "";
      const words = t.value.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3);
      if (!words.length || !threads) return;
      const hits = threads.filter((x) => words.filter((w) => x.title.toLowerCase().includes(w)).length >= Math.min(2, words.length)).slice(0, 4);
      if (!hits.length) return;
      similar.appendChild(el("div", "hint", "Already reported? Press Me too instead of posting it again:"));
      hits.forEach((x) => similar.appendChild(threadRow(x, true)));
    };
    t.oninput = showSimilar;
    showSimilar();
    f.onsubmit = async (e) => {
      e.preventDefault();
      if (!t.value.trim()) { msg.textContent = "Give it a short title."; msg.className = "hb-msg err"; t.focus(); return; }
      if (!d.value.trim() && !fb.files.length) { msg.textContent = "Describe the problem (or attach a screenshot)."; msg.className = "hb-msg err"; d.focus(); return; }
      post.disabled = true; msg.className = "hb-msg"; msg.textContent = fb.files.length ? "Uploading…" : "Posting…";
      const r = await hub("post", { title: t.value.trim(), text: d.value.trim(), files: await fb.encode(), diag: diag.checked });
      post.disabled = false;
      if (!r || !r.ok) { msg.className = "hb-msg err"; msg.textContent = (r && r.error) || "Couldn't post it."; return; }
      openId = r.threadId; render();
    };
    setTimeout(() => (title ? d : t).focus(), 30);
    return f;
  }

  // ----- one thread -----
  function showThread(root) {
    if (!view || view.kind !== "thread" || view.id !== openId) {
      root.textContent = "";
      const id = openId;
      view = { kind: "thread", id };
      const top = el("div", "hb-bar");
      const back = el("button", "hb-mini", "← All issues"); back.type = "button";
      back.onclick = () => { openId = ""; try { history.replaceState(null, "", location.pathname + "#hub"); } catch (e) {} render(); };
      const st = el("span", "hint");
      top.append(back, st);
      const head = el("div"), acts = el("div", "hb-acts"), msgs = el("div", "hb-msgs"), foot = el("div");
      root.append(top, head, acts, msgs, foot);
      Object.assign(view, { status: st, head, acts, msgs, foot, reply: null });
    }
    paintThread();
    refreshThread();
  }
  async function refreshThread() {
    const id = openId;
    status("Updating…");
    const r = await hub("thread", { id }, adminMode);
    if (!view || view.kind !== "thread" || view.id !== id) return;
    status("");
    if (r && r.ok) {
      cache[id] = { thread: r.thread, messages: r.messages || [] };
      const ms = cache[id].messages;
      send({ type: "HUB_SEEN", id, lastAt: ms.length ? ms[ms.length - 1].at : Date.now() });
      paintThread();
    } else if (!cache[id]) { view.msgs.textContent = ""; view.msgs.appendChild(el("div", "hb-msg err", (r && r.error) || "Couldn't load it.")); }
    else status("Couldn't refresh: " + ((r && r.error) || "no answer"));
    clearTimeout(timer);
    timer = setTimeout(() => { if (openId === id && view && view.id === id && !document.hidden) refreshThread(); }, 45000);
  }
  function paintThread() {
    const c = cache[openId];
    if (!view || view.kind !== "thread") return;
    if (!c) { view.msgs.textContent = ""; view.msgs.appendChild(el("div", "hb-empty", "Loading…")); return; }
    const th = c.thread;
    // head
    view.head.textContent = "";
    const head = el("div", "hb-head");
    head.appendChild(el("h3", "", (th.pinned ? "📌 " : "") + (th.locked ? "🔒 " : "") + th.title));
    if (th.status === "resolved") head.appendChild(el("span", "hb-badge", th.fixedIn ? "Fixed in v" + th.fixedIn : "Resolved"));
    if (th.fixedIn && cmpV(VERSION, th.fixedIn) < 0) head.appendChild(el("span", "hb-badge warn", "You have v" + VERSION + " - update to get the fix"));
    view.head.appendChild(head);
    // actions
    view.acts.textContent = "";
    const me = el("button", "", (th.metooMine ? "✓ Me too" : "Me too") + (th.metoo ? " (" + th.metoo + ")" : "")); me.type = "button";
    me.title = "You have the same problem - you'll be told when it's fixed";
    me.onclick = async () => { me.disabled = true; th.metooMine = !th.metooMine; th.metoo += th.metooMine ? 1 : -1; paintThread(); await hub("metoo", { id: th.id }); refreshThread(); };
    view.acts.appendChild(me);
    if (adminMode) {
      const op = (label, o, confirmText) => { const b = el("button", "", label); b.type = "button"; b.onclick = async () => { if (confirmText && !confirm(confirmText)) return; b.disabled = true; status("Saving…"); const x = await hub("mod", { id: th.id, ...o }, true); if (!x || !x.ok) alert((x && x.error) || "Didn't work."); if (o.op === "deleteThread") { delete cache[th.id]; threads = threads && threads.filter((t) => t.id !== th.id); openId = ""; render(); return; } refreshThread(); }; view.acts.appendChild(b); };
      op(th.pinned ? "Unpin" : "📌 Pin", { op: th.pinned ? "unpin" : "pin" });
      op(th.locked ? "Unlock" : "🔒 Lock", { op: th.locked ? "unlock" : "lock" });
      if (th.status === "resolved") op("Reopen", { op: "reopen" });
      else {
        const b = el("button", "", "✓ Resolve…"); b.type = "button";
        b.onclick = async () => { const v = prompt("Fixed in which version? (leave empty if no update is needed)", VERSION); if (v === null) return; b.disabled = true; status("Saving…"); await hub("mod", { id: th.id, op: "resolve", fixedIn: v.trim().replace(/^v/i, "") }, true); refreshThread(); };
        view.acts.appendChild(b);
      }
      const rn = el("button", "", "Rename…"); rn.type = "button";
      rn.onclick = async () => { const v = prompt("New title", th.title); if (!v || !v.trim()) return; status("Saving…"); await hub("mod", { id: th.id, op: "rename", title: v.trim() }, true); refreshThread(); };
      view.acts.appendChild(rn);
      op("Delete thread", { op: "deleteThread" }, "Delete this whole thread for everyone?");
    }
    // reply box first (the messages' Reply links use it): made once per thread
    // view, so a draft survives every refresh
    if (!th.locked || adminMode) {
      if (!view.reply) { view.reply = replyBox(th); view.foot.textContent = ""; view.foot.appendChild(view.reply.form); }
    } else { view.reply = null; view.foot.textContent = ""; view.foot.appendChild(el("p", "hint", "This thread is locked by the admin.")); }
    // messages
    view.msgs.textContent = "";
    for (const m of c.messages) view.msgs.appendChild(messageEl(m, th));
  }
  function messageEl(m, th) {
    const w = el("div", "hb-m" + (m.role === "admin" ? " admin" : ""));
    if (m.pending) w.style.opacity = ".6";
    w.appendChild(avatar(m));
    const b = el("div", "hb-b");
    const who = el("div", "hb-who");
    who.appendChild(el("b", "", m.name || "Someone"));
    if (m.role === "admin") who.appendChild(el("span", "hb-badge admin", "Admin"));
    who.appendChild(el("span", "", m.pending ? "sending…" : ago(m.at) + (m.editedAt ? " · edited" : "")));
    b.appendChild(who);
    if (m.replyTo) {
      const qt = el("div", "hb-quote");
      qt.appendChild(el("b", "", "↪ " + (m.replyTo.name || "someone") + ": "));
      qt.append(m.replyTo.text || "");
      b.appendChild(qt);
    }
    const tx = el("div", "hb-text"); linkify(tx, m.text || ""); b.appendChild(tx);
    if (m.files && m.files.length) {
      const th2 = el("div", "hb-thumbs");
      for (const f of m.files) {
        if (f.thumb) { const img = el("img"); img.src = f.thumb; img.alt = f.name; img.title = f.name; if (f.url) { img.style.cursor = "pointer"; img.onclick = () => window.open(f.url, "_blank", "noopener"); } th2.appendChild(img); }
        else if (f.url) { const a = el("a", "hb-file", "📎 " + f.name); a.href = f.url; a.target = "_blank"; a.rel = "noopener"; th2.appendChild(a); }
        else th2.appendChild(el("span", "hb-file", "📎 " + f.name + (adminMode || m.pending ? "" : " (the admin can see it)")));
      }
      b.appendChild(th2);
    }
    if (adminMode && m.diag) { const d = el("details"); d.appendChild(el("summary", "", "Diagnostics")); const pre = el("pre", "", m.diag); pre.style.cssText = "white-space:pre-wrap;font-size:11px;max-height:260px;overflow:auto;"; d.appendChild(pre); b.appendChild(d); }
    if (!m.pending) b.appendChild(reactionsEl(m, th));
    const ops = el("div", "hb-ops");
    const opBtn = (label, fn) => { const x = el("button", "", label); x.type = "button"; x.onclick = fn; ops.appendChild(x); };
    if (!m.pending && view.reply) opBtn("Reply", () => view.reply.quote(m));
    if (!m.pending && m.mine && !adminMode) opBtn("Delete", async () => { if (!confirm("Delete your message?")) return; status("Deleting…"); await hub("deleteOwn", { id: m.id }); refreshThread(); });
    if (!m.pending && adminMode) {
      opBtn("Edit", async () => { const v = prompt("Edit the message", m.text); if (v == null) return; m.text = v; m.editedAt = Date.now(); paintThread(); await hub("mod", { op: "editMsg", id: m.id, text: v }, true); refreshThread(); });
      opBtn("Delete", async () => { if (!confirm("Delete this message for everyone?")) return; status("Deleting…"); await hub("mod", { op: "deleteMsg", id: m.id }, true); refreshThread(); });
      if (m.role !== "admin" && m.install && !(info && m.install === info.install)) {
        opBtn("Mute 24 h", async () => { await hub("mod", { op: "mute", install: m.install, hours: 24 }, true); alert((m.name || "They") + " can't post for 24 hours."); });
        opBtn("Ban", async () => { if (!confirm("Stop " + (m.name || "this person") + " from posting at all? (Admin > Team hub can undo it)")) return; await hub("mod", { op: "ban", install: m.install }, true); alert("Banned."); });
      }
    }
    if (ops.childNodes.length) b.appendChild(ops);
    w.appendChild(b);
    return w;
  }
  // 👍 2  ❤️ 1  [☺+] - click to toggle; hover shows who.
  function reactionsEl(m, th) {
    const row = el("div", "hb-rx");
    const toggle = async (emoji) => {
      if (th.locked && !adminMode) return;
      const list = m.reactions || (m.reactions = []);
      let r = list.find((x) => x.emoji === emoji);
      if (!r) { r = { emoji, count: 0, mine: false, who: [] }; list.push(r); }
      r.mine = !r.mine; r.count += r.mine ? 1 : -1;
      const me = (info && info.profile && info.profile.name) || "you";
      r.who = r.mine ? (r.who || []).concat(me) : (r.who || []).filter((n) => n !== me);
      m.reactions = list.filter((x) => x.count > 0);
      paintThread(); // instant, then the real counts
      const x = await hub("react", { id: m.id, emoji });
      if (!x || !x.ok) status(x && /unknown action/.test(x.error || "") ? "Reactions need the updated hub script (Admin > Team hub)." : "Couldn't react: " + ((x && x.error) || "no answer"));
      refreshThread();
    };
    for (const r of m.reactions || []) {
      const c = el("button", "hb-rxc" + (r.mine ? " on" : ""), r.emoji + " " + r.count); c.type = "button";
      c.title = (r.who || []).join(", ") || "";
      c.onclick = () => toggle(r.emoji);
      row.appendChild(c);
    }
    if (!th.locked || adminMode) {
      const add = el("button", "hb-rxc add", "☺+"); add.type = "button"; add.title = "React";
      add.onclick = (e) => {
        e.stopPropagation();
        const old = row.querySelector(".hb-rxpick"); if (old) { old.remove(); return; }
        const pick = el("span", "hb-rxpick");
        for (const emo of REACTIONS) { const p = el("button", "", emo); p.type = "button"; p.onclick = () => toggle(emo); pick.appendChild(p); }
        row.appendChild(pick);
      };
      row.appendChild(add);
    }
    return row;
  }
  function replyBox(th) {
    const f = el("form", "hb-reply");
    const quoteBar = el("div", "hb-quote"); quoteBar.hidden = true;
    let quoted = null;
    const t = el("textarea"); t.maxLength = 4000; t.placeholder = adminMode ? "Reply as admin… (paste screenshots with Ctrl+V)" : "Reply… (paste screenshots with Ctrl+V or drop files)";
    const fb = fileBox(f);
    const foot = el("div", "hb-foot");
    const msg = el("span", "hb-msg");
    const post = el("button", "primary", "Reply"); post.type = "submit";
    foot.append(msg, post);
    f.append(quoteBar, t, fb.box, fb.input, foot);
    const setQuote = (m) => {
      quoted = m;
      quoteBar.textContent = "";
      if (!m) { quoteBar.hidden = true; return; }
      quoteBar.hidden = false;
      quoteBar.appendChild(el("b", "", "Replying to " + (m.name || "someone") + ": "));
      quoteBar.append(String(m.text || "").slice(0, 120));
      const x = el("button", "hb-mini", "✕"); x.type = "button"; x.style.marginLeft = "8px"; x.onclick = () => setQuote(null);
      quoteBar.appendChild(x);
      t.focus();
    };
    t.onkeydown = (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); f.requestSubmit(); } };
    f.onsubmit = async (e) => {
      e.preventDefault();
      if (!t.value.trim() && !fb.files.length) { msg.className = "hb-msg err"; msg.textContent = "Write something first."; return; }
      const text = t.value.trim(), q = quoted;
      post.disabled = true; msg.className = "hb-msg"; msg.textContent = fb.files.length ? "Uploading…" : "Sending…";
      const files = await fb.encode();
      // Shown straight away (faded "sending…") while it goes up.
      const c = cache[th.id];
      const p = info && info.profile ? info.profile : {};
      if (c) { c.messages.push({ id: "pending", pending: true, name: p.name || "You", avatar: p.avatar, color: p.color, initials: p.initials, role: adminMode ? "admin" : "user", text, at: Date.now(), files: files.map((x) => ({ name: x.name })), replyTo: q ? { name: q.name, text: String(q.text || "").slice(0, 140) } : null }); paintThread(); }
      const r = await hub("post", { threadId: th.id, text, files, replyTo: q ? q.id : "" }, adminMode);
      post.disabled = false;
      if (!r || !r.ok) {
        if (c) { c.messages = c.messages.filter((x) => !x.pending); paintThread(); }
        msg.className = "hb-msg err"; msg.textContent = (r && r.error) || "Couldn't send it.";
        return;
      }
      t.value = ""; fb.clear(); setQuote(null); msg.textContent = "";
      refreshThread();
    };
    return { form: f, quote: setQuote };
  }

  // ---------- Admin > Team hub ----------
  async function startAdmin() {
    const card = $("hubAdminCard");
    if (!card) return;
    const i = await send({ type: "HUB_INFO" });
    const msg = $("hubAdmMsg");
    const say = (t, bad) => { msg.style.display = "inline"; msg.textContent = t; msg.style.color = bad ? "var(--red, #dc2626)" : ""; };
    $("hubAdmCopy").onclick = async () => {
      try { const code = await (await fetch(chrome.runtime.getURL("team-hub.gs"))).text(); await navigator.clipboard.writeText(code); say("Script copied ✓ Paste it into script.google.com (steps above)."); }
      catch (e) { say("Couldn't copy it: " + e.message, true); }
    };
    $("hubAdmSave").onclick = async () => {
      say("Testing…");
      const r = await send({ type: "ADMIN_HUB_SAVE", url: $("hubAdmUrl").value.trim(), key: $("hubAdmKey").value.trim() });
      if (!r || !r.ok) { say((r && r.error) || "Didn't work.", true); return; }
      $("hubAdmKey").value = "";
      say("Connected ✓ " + (r.shared ? "Everyone's extension gets it on its next check (within a few minutes)." : "Saved on this computer only: " + r.shareError + "."), !r.shared);
      loadUsers();
    };
    if (i && i.adminKey) { $("hubAdmKey").placeholder = "Saved ✓ (enter a new key only to change it)"; loadUsers(); }
  }
  // One person, several rows. The hub's Users sheet is keyed by INSTALL id, not by
  // ClickUp user, so a reinstall, a second Chrome profile or a new computer gives
  // the same person a second honest row - which is why a name showed up twice in
  // the admin panel. Group by ClickUp user id and show the copy that checked in
  // most recently; the older ones stay reachable behind a toggle so they can be
  // removed rather than quietly hidden. A row with no ClickUp id yet (the
  // extension checked in before ClickUp was connected) matches nobody, so it
  // stands on its own instead of being folded into someone else.
  function dedupeUsers(list) {
    const seen = new Map(), out = [];
    for (const u of Array.isArray(list) ? list : []) {
      if (!u) continue;
      const k = String(u.cuUserId || "").trim();
      if (!k) { out.push({ row: u, dupes: [] }); continue; }
      const g = seen.get(k);
      if (!g) { const n = { row: u, dupes: [] }; seen.set(k, n); out.push(n); continue; }
      g.dupes.push(u);
    }
    // The hub sorts newest-first already, but which row is "the current one" is
    // too important to depend on a hand-deployed script for: decide it here.
    for (const g of out) {
      if (!g.dupes.length) continue;
      const all = [g.row].concat(g.dupes).sort((a, b) => (Number(b.lastSeen) || 0) - (Number(a.lastSeen) || 0));
      g.row = all[0];
      g.dupes = all.slice(1);
    }
    return out.sort((a, b) => (Number(b.row.lastSeen) || 0) - (Number(a.row.lastSeen) || 0));
  }
  // The hub script is pasted into Apps Script and deployed by hand, so a copy of
  // the extension can be newer than the script behind it. An older script doesn't
  // know "forget" and falls through to its thread branch, so say that plainly
  // instead of leaving a button that does nothing.
  const OLD_HUB = "Your Team hub script is older than this extension - it doesn't know how to remove a user yet. Copy team-hub.gs again (the button above), paste it into Apps Script and deploy a new version.";
  const hubErr = (r) => (r && r.ok) ? "" : (r && /thread not found|unknown op/i.test(String(r.error || "")) ? OLD_HUB : ((r && r.error) || "Didn't work."));

  // 🔔 to many at once: everyone, only those not on this version, or people you
  // tick. Same pipe as each row's Notify (one hub "nudge" per person, sent one
  // after another), so the hub's own limits and the "no extension yet" answer
  // apply per person and are reported per person.
  function bulkNotify(people, myInstall) {
    const wrap = el("div", "hb-bulk");
    wrap.style.cssText = "margin:4px 0 10px;";
    const others = people.map((g) => g.row).filter((u) => !(myInstall && u.install === myInstall) && String(u.cuUserId || "").trim());
    const behind = others.filter((u) => u.version && cmpV(u.version, VERSION) < 0);
    const bar = el("div");
    bar.style.cssText = "display:flex;gap:6px;flex-wrap:wrap;align-items:center;";
    const panel = el("div");
    panel.style.cssText = "display:none;margin-top:8px;padding:10px;border:1px solid var(--border);border-radius:10px;background:var(--card);";
    let mode = "";
    const open = (m) => {
      if (mode === m && panel.style.display !== "none") { panel.style.display = "none"; mode = ""; return; }
      mode = m;
      panel.style.display = "";
      panel.textContent = "";
      const head = el("div", "", m === "all" ? "Message to everyone (" + others.length + ")" : m === "behind" ? "Message to the " + behind.length + " not on v" + VERSION : "Message to the people you tick");
      head.style.cssText = "font-weight:600;font-size:13px;margin-bottom:6px;";
      panel.appendChild(head);
      let picks = null;
      if (m === "pick") {
        picks = el("div");
        picks.style.cssText = "display:flex;flex-wrap:wrap;gap:4px 14px;margin:0 0 8px;font-size:12.5px;max-height:160px;overflow:auto;";
        for (const u of others) {
          const lab = el("label");
          lab.style.cssText = "display:inline-flex;gap:5px;align-items:center;margin:0;font-weight:400;";
          const cb = el("input"); cb.type = "checkbox"; cb.value = String(u.cuUserId); cb._u = u;
          lab.append(cb, (u.name || "Someone") + (u.version ? " · v" + u.version : ""));
          picks.appendChild(lab);
        }
        const tick = el("div"); tick.style.cssText = "display:flex;gap:8px;margin:-2px 0 8px;";
        const allB = el("button", "hb-mini", "Tick all"); allB.type = "button"; allB.onclick = () => picks.querySelectorAll("input").forEach((c) => { c.checked = true; });
        const behB = el("button", "hb-mini", "Tick those not on v" + VERSION); behB.type = "button"; behB.onclick = () => picks.querySelectorAll("input").forEach((c) => { c.checked = !!(c._u.version && cmpV(c._u.version, VERSION) < 0); });
        const noneB = el("button", "hb-mini", "None"); noneB.type = "button"; noneB.onclick = () => picks.querySelectorAll("input").forEach((c) => { c.checked = false; });
        tick.append(allB, behB, noneB);
        panel.append(picks, tick);
      }
      const ta = el("textarea");
      ta.rows = 2; ta.maxLength = 300;
      ta.style.cssText = "width:100%;box-sizing:border-box;font:inherit;font-size:12.5px;";
      ta.value = m === "behind" ? "Please open Personal ClickUp Manager (click its icon) so it updates to v" + VERSION + " - if it doesn't, go to General › Version and updates and press Check for updates." : "";
      ta.placeholder = "What should they see? e.g. please log your hours before you finish today";
      const row = el("div"); row.style.cssText = "display:flex;gap:8px;align-items:center;margin-top:6px;flex-wrap:wrap;";
      const go = el("button", "hb-mini", "Send"); go.type = "button";
      const no = el("button", "hb-mini", "Cancel"); no.type = "button";
      const out = el("span", "hint", "");
      no.onclick = () => { panel.style.display = "none"; mode = ""; };
      go.onclick = async () => {
        const text = ta.value.trim();
        if (!text) { ta.focus(); out.textContent = "Write the message first."; return; }
        const list = m === "all" ? others : m === "behind" ? behind : [...picks.querySelectorAll("input:checked")].map((c) => c._u);
        if (!list.length) { out.textContent = m === "pick" ? "Tick at least one person." : "Nobody to send it to."; return; }
        if (list.length > 20) out.textContent = "Note: the Team hub takes up to 20 messages an hour from one computer - the rest will be refused for now.";
        go.disabled = true; no.disabled = true;
        const sent = [], missed = [];
        for (let i = 0; i < list.length; i++) {
          const u = list[i];
          go.textContent = "Sending " + (i + 1) + " of " + list.length + "…";
          const rr = await hub("nudge", { toUser: String(u.cuUserId || ""), taskId: "", taskName: "", taskUrl: "", text }, false);
          if (rr && rr.ok) sent.push(u.name || "someone");
          else missed.push((u.name || "someone") + " (" + (rr && rr.reason === "no-extension" ? "hasn't opened the extension since the hub was set up" : hubErr(rr)) + ")");
        }
        go.disabled = false; no.disabled = false; go.textContent = "Send";
        out.textContent = (sent.length ? "Sent to " + sent.length + " ✓ - each sees it within a few minutes as a notification." : "") +
          (missed.length ? (sent.length ? " " : "") + "Not sent: " + missed.join(", ") + "." : "");
        out.style.color = missed.length && !sent.length ? "var(--red)" : "";
      };
      row.append(go, no, out);
      panel.append(ta, row);
      ta.focus();
    };
    const mk = (label, title, m, disabled) => { const b = el("button", "hb-mini", label); b.type = "button"; b.title = title; b.disabled = !!disabled; b.onclick = () => open(m); bar.appendChild(b); return b; };
    mk("🔔 Notify everyone", "Send everyone (except you) a message in their extension", "all", !others.length);
    mk("🔔 Notify those not on v" + VERSION + " (" + behind.length + ")", "Only the people whose copy last reported an older version - with a ready-made 'please update' message you can change", "behind", !behind.length);
    mk("🔔 Choose people…", "Tick who should get the message", "pick", !others.length);
    wrap.append(bar, panel);
    return wrap;
  }
  let youOwner = false; // this copy holds the hub's admin key (sets roles)
  async function loadUsers() {
    const box = $("hubAdmUsers");
    if (!box) return;
    // Keep what's shown while it reloads, and say so (no blank flash).
    let note = box.querySelector(".hb-usersnote");
    if (note) note.firstChild.textContent = "Updating…"; else box.textContent = "Loading…";
    const r = await hub("users", {}, true);
    const myInstall = ((await send({ type: "HUB_INFO" })) || {}).install || "";
    box.textContent = "";
    if (!r || !r.ok) { box.appendChild(el("div", "hb-msg err", (r && r.error) || "Couldn't load the users.")); return; }
    const people = dedupeUsers(r.users);
    const extra = people.reduce((n, g) => n + g.dupes.length, 0);
    // What these numbers are: each copy's own last check-in.
    note = el("div", "hint hb-usersnote");
    note.style.cssText = "display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:6px;";
    note.appendChild(el("span", "", "Checked " + new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) +
      ". A version here is what that copy last reported, not what it is running right now: a copy checks in when someone opens it (at most hourly), at least once a day, and straight after it updates. So a version can lag by up to a day - ↻ re-reads the row, 🔔 asks the person to open their extension."));
    const rf = el("button", "hb-mini", "↻ Refresh"); rf.type = "button"; rf.onclick = () => loadUsers();
    note.appendChild(rf);
    box.appendChild(note);
    const st = r.settings || {};
    const stats = el("div", "hb-stats");
    const day = 86400000, nowMs = Date.now();
    const since = (g) => nowMs - (Number(g.row.lastSeen) || 0);
    const oldV = people.filter((g) => g.row.version && cmpV(g.row.version, VERSION) < 0).length;
    const nums = [[people.length, "people"], [people.filter((g) => since(g) < day).length, "active today"],
      [people.filter((g) => since(g) < 7 * day).length, "active this week"], [oldV, "on an older version"]];
    if (extra) nums.push([extra, extra === 1 ? "older copy" : "older copies"]);
    for (const [n, l] of nums) { const s = el("span"); s.appendChild(el("b", "", String(n))); s.append(l); stats.appendChild(s); }
    box.appendChild(stats);
    box.appendChild(bulkNotify(people, myInstall));
    const set = el("div", "hb-bar");
    const slow = el("select");
    for (const [v, l] of [[0, "Slow mode off"], [1, "1 message / min"], [5, "1 message / 5 min"], [15, "1 message / 15 min"], [60, "1 message / hour"]]) { const o = el("option", "", l); o.value = String(v); if (Number(st.slowMin || 0) === v) o.selected = true; slow.appendChild(o); }
    const pubL = el("label"); pubL.style.cssText = "font-size:12.5px;display:flex;gap:6px;align-items:center;";
    const pub = el("input"); pub.type = "checkbox"; pub.checked = !!st.filesPublic;
    pubL.append(pub, "Everyone can see the screenshots people attach in Help & issues (otherwise only admins)");
    pubL.title = "When someone reports a problem in Help & issues with a screenshot, the other people reading that thread see it too when this is ticked. Unticked, only admins see screenshots - safer, because a screenshot can show a client's data.";
    const saveSet = async () => { await hub("settings", { slowMin: Number(slow.value), filesPublic: pub.checked }, true); };
    slow.onchange = saveSet; pub.onchange = saveSet;
    set.append(slow, pubL);
    box.appendChild(set);
    // One line under the table for whatever the row buttons have to report, so a
    // ↻ that found nothing new or a send that was refused doesn't vanish.
    const msg = el("div", "hb-msg");
    msg.style.display = "none";
    const say = (t, bad) => { msg.style.display = t ? "" : "none"; msg.textContent = t || ""; msg.className = "hb-msg" + (bad ? " err" : ""); };
    const tbl = el("table", "hb-users");
    tbl.dataset.long = "hub-users"; tbl.dataset.longRows = "tr.hb-urow"; tbl.dataset.longMax = "15";
    const hr = el("tr"); for (const h of ["", "Name", "Role", "Version (reported)", "Last active", "", ""]) hr.appendChild(el("th", "", h));
    youOwner = !!r.youOwner;
    tbl.appendChild(hr);
    for (const g of people) drawUser(tbl, g, myInstall, say);
    box.appendChild(tbl);
    if (extra) {
      const all = el("button", "hb-mini", "Remove all " + extra + " older cop" + (extra === 1 ? "y" : "ies"));
      all.type = "button";
      all.style.marginTop = "8px";
      all.title = "Delete the leftover rows for people who appear more than once. The copy each of them is using now is untouched.";
      all.onclick = async () => {
        if (!confirm("Remove " + extra + " older cop" + (extra === 1 ? "y" : "ies") + "?\n\nThese are rows the same people left behind by reinstalling or using a second Chrome profile. The copy each person uses now stays in the list, and nothing changes on anybody's computer."))
          return;
        all.disabled = true; all.textContent = "Removing…";
        let done = 0, stop = "";
        for (const g of people) {
          for (const d of g.dupes) {
            const rr = await hub("mod", { op: "forget", install: d.install }, true);
            if (rr && rr.ok) { done++; continue; }
            stop = hubErr(rr);
            break;
          }
          if (stop) break;
        }
        if (stop) say(done ? "Removed " + done + " of " + extra + ", then stopped: " + stop : stop, true);
        loadUsers();
      };
      box.appendChild(all);
    }
    box.appendChild(msg);
  }

  // One person's row, plus the two rows that fold out of it: their older copies
  // and the Notify composer.
  function drawUser(tbl, g, myInstall, say) {
    const u = g.row;
    const mine = !!(myInstall && u.install === myInstall);
    const dupRow = el("tr"); dupRow.style.display = "none";
    const noteRow = el("tr"); noteRow.style.display = "none";
    const tr = el("tr", "hb-urow");
    const c0 = el("td"); c0.appendChild(avatar(u)); tr.appendChild(c0);
    const cn = el("td");
    cn.appendChild(el("div", "", u.name || "(no name)"));
    if (g.dupes.length) {
      const label = () => g.dupes.length + " older cop" + (g.dupes.length === 1 ? "y" : "ies");
      const more = el("button", "hb-mini", "▸ " + label());
      more.type = "button";
      more.style.marginTop = "3px";
      more.title = "The same person on an older install id - from a reinstall or a second Chrome profile. Only the copy they are using now is listed above.";
      more.onclick = () => { const open = dupRow.style.display === "none"; dupRow.style.display = open ? "" : "none"; more.textContent = (open ? "▾ " : "▸ ") + label(); };
      cn.appendChild(more);
    }
    tr.appendChild(cn);
    // Role: the owner (who holds the admin key) sets User / Admin; shows "Admin"
    // for the owner's own row, which can't be changed.
    const cr = el("td");
    if (u.role === "owner") cr.appendChild(el("span", "hb-role adm", "Admin"));
    else if (youOwner) {
      const sel = el("select", "hb-rolesel");
      for (const [v, l] of [["user", "User"], ["admin", "Admin"]]) { const o = el("option", "", l); o.value = v; if ((u.role || "user") === v) o.selected = true; sel.appendChild(o); }
      sel.title = "Admins get the Team hub tools (users, notices, Help & issues moderation) - not publishing versions or shared settings, which need your GitHub token.";
      sel.onchange = async () => {
        const want = sel.value;
        if (want === "admin" && !confirm("Make " + (u.name || "this person") + " an admin?\n\nThey get the Team hub tools: this users list, notices, notifying people and moderating Help & issues. They can't change roles or touch you.")) { sel.value = u.role || "user"; return; }
        sel.disabled = true;
        const rr = await hub("mod", { op: "role", install: u.install, role: want }, true);
        sel.disabled = false;
        if (!(rr && rr.ok)) { sel.value = u.role || "user"; say(hubErr(rr), true); return; }
        u.role = want;
        say((u.name || "They") + (want === "admin" ? " is now an admin (their copy picks it up the next time it checks in)." : " is a user again."));
      };
      cr.appendChild(sel);
    } else cr.appendChild(el("span", "hb-role" + (u.role === "admin" ? " adm" : ""), u.role === "admin" ? "Admin" : "User"));
    tr.appendChild(cr);
    const cv = el("td", "", u.version ? "v" + u.version : "-"); if (u.version && cmpV(u.version, VERSION) < 0) cv.style.color = "#b45309";
    if (u.lastSeen) cv.title = "Reported " + ago(u.lastSeen) + " (" + new Date(u.lastSeen).toLocaleString() + ")";
    tr.appendChild(cv);
    const cl = el("td", "", u.lastSeen ? ago(u.lastSeen) : "-");
    tr.appendChild(cl);
    tr.appendChild(el("td", "", u.state === "banned" ? "Banned" : u.state === "muted" ? "Muted until " + new Date(u.mutedUntil).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : ""));
    const ca = el("td");
    ca.style.whiteSpace = "nowrap";
    const mini = (label, title, fn) => { const b = el("button", "hb-mini", label); b.type = "button"; if (title) b.title = title; b.onclick = () => fn(b); ca.appendChild(b); return b; };

    // ↻ re-reads this one row. It cannot make a copy check in - only that copy
    // decides when to - so it says which of the two happened rather than
    // pretending the number is live.
    mini("↻", "Re-read this person's row from the hub. The version only changes here once their own copy checks in; 🔔 asks them to open it.", async (b) => {
      const was = b.textContent; b.disabled = true; b.textContent = "…";
      const rr = await hub("users", {}, true);
      b.disabled = false; b.textContent = was;
      const fresh = rr && rr.ok && (rr.users || []).find((x) => String(x.install) === String(u.install));
      if (!fresh) { say(hubErr(rr) || "That copy is no longer in the hub - refresh the list.", true); return; }
      const moved = String(fresh.version || "") !== String(u.version || "");
      Object.assign(u, fresh);
      cv.textContent = fresh.version ? "v" + fresh.version : "-";
      cv.style.color = fresh.version && cmpV(fresh.version, VERSION) < 0 ? "#b45309" : "";
      cv.title = fresh.lastSeen ? "Reported " + ago(fresh.lastSeen) + " (" + new Date(fresh.lastSeen).toLocaleString() + ")" : "";
      cl.textContent = fresh.lastSeen ? ago(fresh.lastSeen) : "-";
      const who = u.name || "That copy";
      say(moved
        ? who + " now reports " + (fresh.version ? "v" + fresh.version : "no version") + "."
        : who + " still reports " + (fresh.version ? "v" + fresh.version : "no version") + ", last checked in " + (fresh.lastSeen ? ago(fresh.lastSeen) : "never") + ". Their copy decides when to check in - 🔔 asks them to open it.");
    });

    if (!mine) {
      // 🔔 goes down the same pipe as the reminder one teammate sends another on a
      // task: a desktop notification plus a line in their Reminders tab. No task,
      // so it is just the message - editable, because "update please" and "can you
      // log your hours" are different asks.
      const canNotify = !!String(u.cuUserId || "").trim();
      const nb = mini("🔔 Notify", canNotify
        ? "Send this person a message in their extension - a desktop notification, and a line under From teammates in their Reminders tab."
        : "No ClickUp id for this copy yet, so the hub has no way to address it. It gets one the next time they open the extension with ClickUp connected.",
        () => { const open = noteRow.style.display === "none"; noteRow.style.display = open ? "" : "none"; if (open) ta.focus(); });
      nb.disabled = !canNotify;
      const act = (label, o) => mini(label, "", async (b) => { b.disabled = true; const rr = await hub("mod", { install: u.install, ...o }, true); if (!(rr && rr.ok)) { b.disabled = false; say(hubErr(rr), true); return; } loadUsers(); });
      if (u.state === "banned") act("Unban", { op: "unban" }); else act("Ban", { op: "ban" });
      if (u.state === "muted") act("Unmute", { op: "unmute" }); else if (u.state !== "banned") act("Mute 24 h", { op: "mute", hours: 24 });
      mini("✕", "Remove this copy from the list. It comes back the next time that computer opens the extension.", async (b) => {
        if (!confirm("Remove " + (u.name || "this copy") + " from the list?\n\nThis only deletes the hub's row. Nothing changes on their computer, and the row comes back the next time they open the extension."))
          return;
        b.disabled = true;
        const rr = await hub("mod", { op: "forget", install: u.install }, true);
        if (rr && rr.ok) { loadUsers(); return; }
        b.disabled = false;
        say(hubErr(rr), true);
      });
    } else {
      ca.appendChild(el("span", "hint", "you"));
    }
    tr.appendChild(ca);
    tbl.appendChild(tr);

    if (g.dupes.length) {
      const dc = el("td"); dc.colSpan = 7; dc.style.paddingTop = "0";
      for (const d of g.dupes) {
        const line = el("div");
        line.style.cssText = "display:flex;gap:8px;align-items:center;font-size:12px;color:var(--muted);padding:2px 0;";
        line.appendChild(el("span", "", (d.version ? "v" + d.version : "no version") + " · last active " + (d.lastSeen ? ago(d.lastSeen) : "never") + " · id " + String(d.install || "?").slice(0, 8)));
        const x = el("button", "hb-mini", "✕ Remove"); x.type = "button";
        x.title = "Delete this leftover row. The copy " + (u.name || "this person") + " uses now is not touched.";
        x.onclick = async () => {
          // Asks, like the other two Remove buttons do. Deleting a row is easy to
          // undo (it comes back on that copy's next check-in) but it should never
          // happen on a stray click, and the dialog is where the install id and
          // the date get read properly.
          if (!confirm("Remove this older copy of " + (u.name || "this person") + "?\n\n" +
            (d.version ? "v" + d.version : "No version") + ", last active " + (d.lastSeen ? ago(d.lastSeen) : "never") + ", id " + String(d.install || "?").slice(0, 8) + ".\n\n" +
            "The copy they are using now stays in the list, and nothing changes on their computer."))
            return;
          x.disabled = true;
          const rr = await hub("mod", { op: "forget", install: d.install }, true);
          if (rr && rr.ok) { loadUsers(); return; }
          x.disabled = false;
          say(hubErr(rr), true);
        };
        line.appendChild(x);
        dc.appendChild(line);
      }
      dupRow.appendChild(dc);
      tbl.appendChild(dupRow);
    }

    if (mine) return;
    const behind = u.version && cmpV(u.version, VERSION) < 0;
    const nc = el("td"); nc.colSpan = 7; nc.style.paddingTop = "0";
    const form = el("div");
    form.style.cssText = "display:flex;gap:6px;flex-wrap:wrap;align-items:flex-start;padding:2px 0 8px;";
    const ta = el("textarea");
    ta.rows = 2; ta.maxLength = 300;
    ta.style.cssText = "flex:1;min-width:240px;font:inherit;font-size:12.5px;";
    ta.value = behind
      ? "Please open Personal ClickUp Manager (click its icon) so it updates to v" + VERSION + " - this list still shows you on v" + u.version + "."
      : "";
    ta.placeholder = "What should they see? e.g. please log your hours before you finish today";
    const go = el("button", "hb-mini", "Send"); go.type = "button";
    const no = el("button", "hb-mini", "Cancel"); no.type = "button";
    const cnt = el("span", "hint", "");
    const count = () => { cnt.textContent = ta.value.trim().length + "/300"; };
    ta.oninput = count; count();
    no.onclick = () => { noteRow.style.display = "none"; };
    go.onclick = async () => {
      const text = ta.value.trim();
      if (!text) { ta.focus(); say("Write what to tell them first.", true); return; }
      go.disabled = true; go.textContent = "Sending…";
      const rr = await hub("nudge", { toUser: String(u.cuUserId || ""), taskId: "", taskName: "", taskUrl: "", text }, false);
      go.disabled = false; go.textContent = "Send";
      if (rr && rr.ok) { noteRow.style.display = "none"; say("Sent to " + (u.name || "them") + " ✓ Their extension shows it within a few minutes - as a notification, and under From teammates in their Reminders tab."); return; }
      say(rr && rr.reason === "no-extension"
        ? (u.name || "They") + " hasn't opened the extension since the Team hub was set up, so there is nowhere to deliver it yet."
        : hubErr(rr), true);
    };
    form.append(ta, go, no, cnt);
    nc.appendChild(form);
    noteRow.appendChild(nc);
    tbl.appendChild(noteRow);
  }

  const boot = () => { start(); startAdmin(); };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot); else boot();
  window.addEventListener("hashchange", () => { if (location.hash === "#hub") start(); });
})();
