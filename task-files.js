// Options > Task files: add each client's audit / reference files once, and
// "Explain this task" (and the client report) use them for that client's tasks.
(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  if (!$("tfCard") || !window.PcmFiles) return;
  const F = window.PcmFiles;
  const send = (msg, ms = 30000) => new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), ms);
    try { chrome.runtime.sendMessage(msg, (r) => { clearTimeout(t); void chrome.runtime.lastError; resolve(r || null); }); } catch (e) { clearTimeout(t); resolve(null); }
  });
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const fmtSize = (n) => n < 1024 ? n + " B" : n < 1048576 ? Math.round(n / 1024) + " KB" : (n / 1048576).toFixed(1) + " MB";
  const icon = (r) => r.kind === "image" ? "\u{1F5BC}" : r.kind === "unreadable" ? "⚠" : /\.pdf$/i.test(r.name) ? "\u{1F4D5}" : /\.(xlsx|csv|tsv)$/i.test(r.name) ? "\u{1F4CA}" : "\u{1F4C4}";

  let myClients = [];     // from my tasks
  let allClients = [];    // whole workspace (loaded on demand)
  let files = [];         // every stored file
  const open = new Set(); // expanded client keys

  function mine() {
    return chrome.storage.local.get("clickupState").catch(() => ({})).then((g) => {
      const st = (g && g.clickupState) || {};
      const names = new Map();
      for (const b of [st, st.todayFilter, st.thisWeek, st.nextWeek]) {
        if (!b) continue;
        for (const k of ["tasks", "deadlineTasks", "trackedTasks"]) for (const t of b[k] || []) {
          const c = String((t && (t.client || (t.container && t.container.listName))) || "").trim();
          if (c && !/extra tasks?|daily tracking/i.test(c)) names.set(F.key(c), c);
        }
      }
      return [...names.values()];
    });
  }

  async function load() {
    files = await F.all().catch(() => []);
    myClients = await mine();
    render();
  }

  function clientsShown() {
    const byKey = new Map();
    const src = $("tfAll").checked && allClients.length ? allClients : myClients;
    for (const c of src) byKey.set(F.key(c), c);
    for (const f of files) if (!byKey.has(f.ck)) byKey.set(f.ck, f.client); // clients with files always show
    const q = $("tfSearch").value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
    return [...byKey.entries()].filter(([k]) => !q || k.includes(q)).sort((a, b) => a[1].replace(/^[^a-z0-9]+/i, "").localeCompare(b[1].replace(/^[^a-z0-9]+/i, "")));
  }

  function render() {
    const list = $("tfList");
    const rows = clientsShown();
    const withFiles = new Set(files.map((f) => f.ck));
    $("tfSummary").textContent = rows.length
      ? rows.filter(([k]) => withFiles.has(k)).length + " of " + rows.length + " clients have files · " + files.length + " file" + (files.length === 1 ? "" : "s") + " in total"
      : "";
    if (!rows.length) {
      list.innerHTML = '<div class="hint" style="padding:14px;">' + ($("tfSearch").value ? "No client matches that search." : "No clients found yet. Open the dashboard once so your tasks load, or tick “All workspace clients”.") + "</div>";
      return;
    }
    list.innerHTML = rows.map(([k, name]) => {
      const fs = files.filter((f) => f.ck === k).sort((a, b) => a.addedAt - b.addedAt);
      const isOpen = open.has(k);
      return '<div class="tf-client' + (fs.length ? "" : " empty") + '" data-ck="' + esc(k) + '" data-name="' + esc(name) + '">' +
        '<div class="tf-head"><button type="button" class="tf-tog" aria-expanded="' + isOpen + '">' + (isOpen ? "▾" : "▸") + "</button>" +
        '<span class="tf-name">' + esc(name) + "</span>" +
        '<span class="tf-count">' + (fs.length ? fs.length + " file" + (fs.length === 1 ? "" : "s") : "no files") + "</span>" +
        '<button type="button" class="tf-add">+ Add files</button></div>' +
        (isOpen
          ? '<div class="tf-files">' + (fs.length ? fs.map((f) =>
              '<div class="tf-file' + (f.kind === "unreadable" ? " bad" : "") + '"><span class="tf-ic">' + icon(f) + "</span>" +
              '<span class="tf-fn" title="' + esc(f.name) + '">' + esc(f.name) + "</span>" +
              '<span class="hint">' + fmtSize(f.size || 0) + " · " + new Date(f.addedAt).toLocaleDateString([], { month: "short", day: "numeric" }) +
              (f.kind === "text" ? " · " + (f.text || "").length.toLocaleString() + " characters read" : f.kind === "image" ? " · image (Chrome's built-in AI)" : " · " + esc(f.why || "can't be read")) + "</span>" +
              '<button type="button" class="tf-rm" data-id="' + esc(f.id) + '" title="Remove this file">✕</button></div>').join("")
            : '<div class="hint" style="padding:6px 0;">Drop files here or click + Add files.</div>') + "</div>"
          : "") + "</div>";
    }).join("");
  }

  // ---- adding ----
  const picker = $("tfPicker");
  let pickFor = null;
  async function addTo(ck, name, list) {
    if (!list || !list.length) return;
    open.add(ck);
    const msg = $("tfMsg");
    msg.hidden = false;
    msg.style.color = "";
    msg.textContent = "Reading " + list.length + " file" + (list.length === 1 ? "" : "s") + " for " + name + "…";
    try {
      const added = await F.add(name, list);
      const bad = added.filter((r) => r.kind === "unreadable");
      msg.textContent = "Added " + added.length + " file" + (added.length === 1 ? "" : "s") + " to " + name + "." +
        (bad.length ? " Couldn't read: " + bad.map((r) => r.name + " (" + r.why + ")").join(", ") + "." : "");
      if (bad.length) msg.style.color = "var(--amber, #d97706)";
    } catch (e) {
      msg.style.color = "var(--red)";
      msg.textContent = "Couldn't add: " + (e && e.message ? e.message : e);
    }
    await load();
  }
  picker.onchange = () => { if (pickFor) addTo(pickFor.ck, pickFor.name, [...picker.files]); picker.value = ""; };
  $("tfList").addEventListener("click", async (e) => {
    const box = e.target.closest(".tf-client");
    if (!box) return;
    const ck = box.dataset.ck, name = box.dataset.name;
    if (e.target.closest(".tf-add")) { pickFor = { ck, name }; picker.click(); return; }
    const rm = e.target.closest(".tf-rm");
    if (rm) {
      const f = files.find((x) => x.id === rm.dataset.id);
      if (f && confirm("Remove “" + f.name + "” from " + name + "?")) { await F.remove(f.id); await load(); }
      return;
    }
    if (e.target.closest(".tf-head")) { if (open.has(ck)) open.delete(ck); else open.add(ck); render(); }
  });
  // Drop files on a client (or anywhere in its box).
  $("tfList").addEventListener("dragover", (e) => { const b = e.target.closest(".tf-client"); if (b) { e.preventDefault(); b.classList.add("over"); } });
  $("tfList").addEventListener("dragleave", (e) => { const b = e.target.closest(".tf-client"); if (b && !b.contains(e.relatedTarget)) b.classList.remove("over"); });
  $("tfList").addEventListener("drop", (e) => {
    const b = e.target.closest(".tf-client");
    if (!b) return;
    e.preventDefault();
    b.classList.remove("over");
    addTo(b.dataset.ck, b.dataset.name, [...(e.dataTransfer.files || [])]);
  });

  // ---- filters ----
  $("tfSearch").oninput = render;
  $("tfAll").onchange = async () => {
    if ($("tfAll").checked && !allClients.length) {
      $("tfSummary").textContent = "Loading every client in the workspace…";
      const r = await send({ type: "CLICKUP_CLIENT_NAMES" }, 60000);
      allClients = (r && Array.isArray(r.names) ? r.names : []).map((n) => (typeof n === "string" ? n : n && n.name) || "").filter(Boolean);
    }
    render();
  };

  // ---- Drive backup ----
  chrome.storage.local.get("settings").then((g) => { $("tfDrive").checked = !(g.settings && g.settings.taskFilesDrive === false); }).catch(() => {});
  $("tfDrive").onchange = () => {
    send({ type: "SET_SETTINGS", patch: { taskFilesDrive: $("tfDrive").checked } });
    if ($("tfDrive").checked) send({ type: "TASKFILES_SYNC" }, 120000);
  };

  // Load when the tab is first opened; a fresh install signed in to Drive gets
  // its files back from the backup first.
  let loaded = false;
  const panel = document.querySelector('.panel[data-panel="files"]');
  const maybeLoad = async () => {
    if (loaded || !panel || !panel.classList.contains("on")) return;
    loaded = true;
    await load();
    if (!files.length) {
      const r = await send({ type: "TASKFILES_SYNC" }, 120000);
      if (r && r.restored) { $("tfMsg").hidden = false; $("tfMsg").textContent = "Restored " + r.restored + " file" + (r.restored === 1 ? "" : "s") + " from your Drive backup."; await load(); }
    }
  };
  new MutationObserver(maybeLoad).observe(panel, { attributes: true, attributeFilter: ["class"] });
  maybeLoad();
  chrome.storage.onChanged.addListener((ch, area) => { if (area === "local" && ch.taskFilesChangedAt && loaded) load(); });
})();
