// Shared task export, used by the popup, the side panel and the options page.
// Exports exactly the rows a page hands over (so it follows whatever filters are
// on screen) as CSV, Excel, Google Sheets or Google Docs.
//
// Sheet layout matches the one the team already uses:
//   column A: "main" / "sub task"      column B: the task text (main rows bold)
// "Include details" adds Client / Due / Estimate / Tracked / Status / Link.
// No AI anywhere - this just reformats data the extension already holds.
(function () {
  const PCM = {};
  const css = document.createElement("style");
  css.textContent = `
    .xp-menu { position: fixed; z-index: 1000; width: 250px; background: var(--card); color: var(--text); border: 1px solid var(--border);
      border-radius: 10px; box-shadow: 0 12px 28px rgba(0,0,0,.2); padding: 8px; font-size: 12.5px; }
    .xp-menu h4 { margin: 2px 4px 6px; font-size: 12px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); }
    .xp-menu .xp-sub { margin: 0 4px 8px; color: var(--muted); font-size: 11.5px; }
    .xp-opt { display: flex; align-items: center; gap: 8px; padding: 6px 6px; border-radius: 7px; cursor: pointer; }
    .xp-opt:hover { background: var(--bg2); }
    .xp-opt input { margin: 0; }
    .xp-item { display: flex; align-items: center; gap: 8px; width: 100%; text-align: left; font: inherit; font-size: 12.5px; padding: 7px 8px;
      border: 0; border-radius: 7px; background: none; color: var(--text); cursor: pointer; }
    .xp-item:hover { background: var(--bg2); }
    .xp-item:disabled { opacity: .55; cursor: default; }
    .xp-sep { height: 1px; background: var(--border); margin: 6px 0; }
    .xp-msg { margin: 6px 4px 2px; font-size: 11.5px; color: var(--muted); }
    .xp-msg.err { color: var(--red); }
  `;
  document.head.appendChild(css);

  const esc = (s) => String(s == null ? "" : s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
  const csvCell = (s) => '"' + String(s == null ? "" : s).replace(/"/g, '""') + '"';
  function fmtMs(ms) {
    const m = Math.round(Math.max(0, Number(ms) || 0) / 60000);
    if (!m) return "";
    const h = Math.floor(m / 60);
    return h ? h + "h" + (m % 60 ? " " + (m % 60) + "m" : "") : m + "m";
  }
  const fmtDate = (ms) => (ms ? new Date(ms).toLocaleDateString([], { year: "numeric", month: "short", day: "numeric" }) : "");

  // rows: [{ name, isSubtask, client, dueDateMs, estimateMs, spentMs, status, done, url }]
  function toMatrix(rows, details) {
    const head = details ? ["", "Task", "Client", "Due", "Estimate", "Tracked", "Status", "Link"] : ["", "Task"];
    const out = [head];
    for (const t of rows) {
      const base = [t.isSubtask ? "sub task" : "main", t.name || ""];
      out.push(details
        ? base.concat([t.client || "", fmtDate(t.dueDateMs), fmtMs(t.estimateMs), fmtMs(t.spentMs), t.status || (t.done ? "complete" : ""), t.url || ""])
        : base);
    }
    return out;
  }
  const toCsv = (m) => m.map((r) => r.map(csvCell).join(",")).join("\r\n");
  // HTML table: Excel opens it, and Google Drive converts it keeping the bold.
  function toHtml(m, title) {
    const rows = m.map((r, i) => {
      if (!i) return "<tr>" + r.map((c) => '<td style="background:#000000;color:#ffffff;font-weight:bold">' + esc(c) + "</td>").join("") + "</tr>";
      const main = r[0] === "main";
      const a = '<td style="font-style:italic;vertical-align:bottom">' + esc(r[0]) + "</td>";
      const b = '<td style="vertical-align:top' + (main ? ";font-weight:bold" : "") + '">' + esc(r[1]).replace(/\n/g, "<br>") + "</td>";
      const rest = r.slice(2).map((c) => '<td style="vertical-align:top">' + esc(c) + "</td>").join("");
      return "<tr>" + a + b + rest + "</tr>";
    }).join("");
    return '<html><head><meta charset="utf-8"><title>' + esc(title) + "</title></head><body>" +
      '<table border="1" cellspacing="0" cellpadding="4"><colgroup><col style="width:90px"><col style="width:640px"></colgroup>' +
      rows + "</table></body></html>";
  }
  function download(name, mime, text) {
    const url = URL.createObjectURL(new Blob([text], { type: mime }));
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }
  const safeName = (s) => String(s || "tasks").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 60) || "tasks";

  // Pull each parent's subtasks from ClickUp (one request per task, so only when asked).
  async function withSubtasks(rows, note) {
    const parents = rows.filter((t) => t && t.id != null && !t.isSubtask).map((t) => String(t.id));
    if (!parents.length) return rows;
    note("Fetching subtasks for " + parents.length + " task" + (parents.length === 1 ? "" : "s") + "…");
    let res = null;
    try { res = await chrome.runtime.sendMessage({ type: "CLICKUP_EXPORT_SUBTASKS", taskIds: parents }); } catch (e) { res = null; }
    const map = (res && res.ok && res.subtasks) || {};
    const out = [];
    for (const t of rows) {
      out.push(t);
      if (t.isSubtask) continue;
      for (const s of map[String(t.id)] || []) {
        if (rows.some((r) => String(r.id) === String(s.id))) continue; // already listed
        out.push({ ...s, isSubtask: true, client: t.client });
      }
    }
    return out;
  }

  function openMenu(btn, getData) {
    const old = document.querySelector(".xp-menu");
    if (old) { old.remove(); return; }
    const menu = document.createElement("div");
    menu.className = "xp-menu";
    menu.onclick = (e) => e.stopPropagation();
    document.body.appendChild(menu);
    const r = btn.getBoundingClientRect();
    menu.style.top = Math.round(r.bottom + 6) + "px";
    menu.style.left = Math.round(Math.max(8, Math.min(window.innerWidth - 258, r.right - 250))) + "px";
    const close = () => menu.remove();
    document.addEventListener("click", close, { once: true });
    document.addEventListener("keydown", function esc2(e) { if (e.key === "Escape") { close(); document.removeEventListener("keydown", esc2); } });

    const data = getData() || { rows: [], title: "tasks" };
    menu.innerHTML = '<h4>Export</h4><div class="xp-sub"></div>';
    menu.querySelector(".xp-sub").textContent = data.rows.length + " task" + (data.rows.length === 1 ? "" : "s") + " · " + (data.title || "current view");

    const mkOpt = (label, checked) => {
      const l = document.createElement("label");
      l.className = "xp-opt";
      const c = document.createElement("input");
      c.type = "checkbox";
      c.checked = checked;
      l.append(c, document.createTextNode(label));
      menu.appendChild(l);
      return c;
    };
    const subs = mkOpt("Include subtasks", true);
    const det = mkOpt("Include details (client, due, estimate)", false);
    menu.appendChild(Object.assign(document.createElement("div"), { className: "xp-sep" }));
    const msg = document.createElement("div");
    msg.className = "xp-msg";

    const run = async (kind, item) => {
      const buttons = [...menu.querySelectorAll(".xp-item")];
      buttons.forEach((b) => (b.disabled = true));
      msg.className = "xp-msg";
      const note = (t) => { msg.textContent = t; };
      try {
        const d = getData() || { rows: [], title: "tasks" };
        let rows = d.rows.slice();
        if (subs.checked) rows = await withSubtasks(rows, note);
        const m = toMatrix(rows, det.checked);
        const title = d.title || "tasks";
        const file = safeName(title) + "_" + new Date().toISOString().slice(0, 10);
        if (kind === "csv") { download(file + ".csv", "text/csv;charset=utf-8", "﻿" + toCsv(m)); note("Saved " + file + ".csv"); }
        else if (kind === "xls") { download(file + ".xls", "application/vnd.ms-excel", toHtml(m, title)); note("Saved " + file + ".xls (opens in Excel)"); }
        else {
          note("Creating in Google Drive…");
          const res = await chrome.runtime.sendMessage({
            type: "EXPORT_TO_GOOGLE", kind, name: file,
            html: toHtml(m, title), // Docs keeps the bold "main" rows
            csv: toCsv(m), // Sheets: Drive only converts csv/xls into a spreadsheet
          });
          if (!res || !res.ok) throw new Error((res && (res.error || res.reason)) || "Google export failed");
          note("Opening…");
          chrome.tabs.create({ url: res.url }).catch(() => {});
          setTimeout(close, 700);
        }
      } catch (e) {
        msg.className = "xp-msg err";
        msg.textContent = String((e && e.message) || e);
      }
      buttons.forEach((b) => (b.disabled = false));
      if (item) item.blur();
    };
    for (const [kind, label] of [["csv", "📄 CSV file"], ["xls", "📊 Excel file (.xls)"], ["sheets", "🟩 Google Sheets"], ["docs", "📝 Google Docs"]]) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "xp-item";
      b.textContent = label;
      b.onclick = () => run(kind, b);
      menu.appendChild(b);
    }
    menu.appendChild(msg);
  }

  // Pages call this with their own "what's on screen right now" function.
  PCM.attach = function attach(btn, getData) {
    if (!btn) return;
    btn.onclick = (e) => { e.stopPropagation(); openMenu(btn, getData); };
  };
  window.pcmExport = PCM;
})();
