// Shared task export, used by the popup, the side panel and the options page.
// Exports exactly the rows a page hands over (so it follows whatever filters are
// on screen) as CSV, Excel, Markdown, Google Sheets or Google Docs.
//
// Fixed layout, matching the team sheet: main / sub task | Task | Task info |
// Status | Week. "Task info" is the ClickUp description with its planning
// boilerplate stripped (see cleanInfo), keeping the instructions and the WHY.
// Google Docs gets headings + bullets instead of a grid.
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

  // ClickUp descriptions here carry a planning wrapper: quoted blocks
  // (Pre Description: "…"), empty fields (Pre File: "") and labelled lines
  // (WEEK:, DEPARTMENT (plan):, DONE WHEN:, STEP 2 of 4 …). The sheet only wants
  // the plain instruction sentences, plus the WHY line for context.
  // A "labelled" line is one whose text before the first colon reads as a field
  // name: DONE WHEN:, DEPARTMENT (plan):, PAGES / SYSTEMS AFFECTED:, PARENT TASK: …
  function isLabelLine(line) {
    const i = line.indexOf(":");
    if (i < 2 || i > 60) return false;
    const head = line.slice(0, i).replace(/\([^)]*\)|\[[^\]]*\]/g, "").trim();
    return /[A-Z]{2}/.test(head) && !/[a-z]/.test(head);
  }
  const WHY_RE = /^(?:CONTEXT:\s*)?WHY\b[^:]*:\s*(.+)$/i;
  function cleanInfo(text) {
    let t = String(text || "");
    if (!t.trim()) return "";
    t = t.replace(/\r/g, "");
    // Drop empty "Field: """ lines and unwrap the quoted blocks around real text.
    t = t.replace(/^[A-Za-z][A-Za-z ]{0,30}:\s*""\s*$/gm, "");
    t = t.replace(/^((?:Pre )?Description|Checklist File|Pre File|File)\s*:\s*"?/gim, "");
    t = t.replace(/"\s*$/gm, "");
    const prose = [];
    let why = "";
    for (const raw of t.split("\n")) {
      const line = raw.trim();
      if (!line) continue;
      if (/^STEP\s+\d+\s+of\s+\d+/i.test(line)) continue; // "STEP 3 of 4 — ACT-040"
      const w = line.match(WHY_RE);
      if (w) { if (!why) why = w[1].trim(); continue; }
      if (isLabelLine(line)) continue; // WEEK:, DONE WHEN (parent):, PARENT TASK: …
      prose.push(line);
    }
    let out = prose.join(" ").replace(/\s{2,}/g, " ").trim();
    if (why) out = (out ? out + "\n" : "") + "Why: " + why;
    return out.slice(0, 1500);
  }

  // The week a due date falls in, following the "A week runs" setting
  // (Sunday to Saturday by default), e.g. "Sep 20 - Sep 26".
  const WEEK_MODES = { "sun-sat": [0, 7], "mon-sun": [1, 7], "mon-fri": [1, 5], "sun-thu": [0, 5] };
  let weekMode = "sun-sat";
  try {
    chrome.storage.local.get("settings").then((got) => {
      const m = got && got.settings && got.settings.clickupWeekMode;
      if (WEEK_MODES[m]) weekMode = m;
    }).catch(() => {});
  } catch (e) {}
  function weekLabel(ms) {
    if (!ms) return "";
    const conf = WEEK_MODES[weekMode] || WEEK_MODES["sun-sat"];
    const d = new Date(ms);
    d.setHours(0, 0, 0, 0);
    const start = new Date(d);
    start.setDate(d.getDate() - ((d.getDay() - conf[0] + 7) % 7));
    const end = new Date(start);
    end.setDate(start.getDate() + conf[1] - 1);
    const f = (x) => x.toLocaleDateString([], { month: "short", day: "numeric" });
    return f(start) + " - " + f(end);
  }
  // Fixed layout, as the team's sheet uses it.
  // rows: [{ name, isSubtask, info, status, done, dueDateMs }]
  function toMatrix(rows) {
    const out = [["", "Task", "Task info", "Status", "Week"]];
    for (const t of rows) {
      out.push([
        t.isSubtask ? "sub task" : "main",
        t.name || "",
        cleanInfo(t.info),
        t.status || (t.done ? "complete" : ""),
        weekLabel(t.dueDateMs),
      ]);
    }
    return out;
  }
  const toCsv = (m) => m.map((r) => r.map(csvCell).join(",")).join("\r\n");
  // HTML table: Excel opens it, and Google Drive converts it keeping the bold.
  function toHtml(m, title) {
    const rows = m.map((r, i) => {
      if (!i) return "<tr>" + r.map((c) => '<td style="background:#4a86e8;color:#ffffff;font-weight:bold">' + esc(c) + "</td>").join("") + "</tr>";
      const main = r[0] === "main";
      const a = '<td style="font-style:italic;vertical-align:bottom">' + esc(r[0]) + "</td>";
      const b = '<td style="vertical-align:bottom' + (main ? ";font-weight:bold" : "") + '">' + esc(r[1]).replace(/\n/g, "<br>") + "</td>";
      const rest = r.slice(2).map((c) => '<td style="vertical-align:top">' + esc(c) + "</td>").join("");
      return "<tr>" + a + b + rest + "</tr>";
    }).join("");
    return '<html><head><meta charset="utf-8"><title>' + esc(title) + "</title></head><body>" +
      '<table border="1" cellspacing="0" cellpadding="4"><colgroup><col style="width:90px"><col style="width:640px"></colgroup>' +
      rows + "</table></body></html>";
  }
  // Google Docs export: headings and bullets rather than a grid.
  function toDocHtml(rows, title) {
    const parts = ['<html><head><meta charset="utf-8"><title>' + esc(title) + "</title></head><body>"];
    parts.push("<h1>" + esc(title) + "</h1>");
    parts.push("<p><i>" + esc(new Date().toLocaleDateString([], { weekday: "long", year: "numeric", month: "long", day: "numeric" })) + "</i></p>");
    let openList = false;
    const closeList = () => { if (openList) { parts.push("</ul>"); openList = false; } };
    const infoHtml = (t) => cleanInfo(t.info).split("\n").filter(Boolean).map(esc);
    for (const t of rows) {
      const meta = [t.status || (t.done ? "complete" : ""), weekLabel(t.dueDateMs)].filter(Boolean).join(" · ");
      if (!t.isSubtask) {
        closeList();
        if (parts.length > 3) parts.push("<p>&nbsp;</p>"); // space between tasks
        parts.push("<h2>" + esc(t.name || "(task)") + "</h2>");
        if (meta) parts.push('<p style="color:#666666">' + esc(meta) + "</p>");
        for (const line of infoHtml(t)) parts.push('<p style="margin-bottom:6pt">' + line + "</p>");
      } else {
        if (!openList) { parts.push("<ul>"); openList = true; }
        const info = infoHtml(t).join(" ");
        parts.push('<li style="margin-bottom:6pt"><b>' + esc(t.name || "(subtask)") + "</b>" + (meta ? ' <span style="color:#666666">(' + esc(meta) + ")</span>" : "") +
          (info ? "<br>" + info : "") + "</li>");
      }
    }
    closeList();
    parts.push("</body></html>");
    return parts.join("");
  }

  // Markdown: plain text that reads well on its own and travels anywhere.
  function toMarkdown(rows, title) {
    const out = ["# " + title, ""];
    const meta = (t) => [t.status || (t.done ? "complete" : ""), weekLabel(t.dueDateMs)].filter(Boolean).join(" · ");
    const count = rows.length;
    out.push("_" + count + " task" + (count === 1 ? "" : "s") + " · exported " + new Date().toLocaleDateString([], { year: "numeric", month: "long", day: "numeric" }) + "_", "");
    for (const t of rows) {
      const info = cleanInfo(t.info);
      const m = meta(t);
      if (!t.isSubtask) {
        out.push("## " + (t.name || "(task)"));
        if (m) out.push("*" + m + "*");
        if (info) { out.push(""); for (const line of info.split("\n")) out.push(line); }
        out.push("");
      } else {
        out.push("- **" + (t.name || "(subtask)") + "**" + (m ? " (" + m + ")" : ""));
        if (info) for (const line of info.split("\n")) out.push("  " + line);
      }
    }
    return out.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
  }

  function download(name, mime, text) {
    const url = URL.createObjectURL(new Blob([text], { type: mime }));
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.onclick = (e) => e.stopPropagation(); // keep the export menu (and its message) open
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }
  const safeName = (s) => String(s || "tasks").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 60) || "tasks";

  // Ask ClickUp for each task's subtasks AND its own parent, then lay the rows out
  // the way the team's sheet does: every main task followed by its subtasks.
  async function withSubtasks(rows, note, includeSubtasks) {
    const ids = rows.filter((t) => t && t.id != null).map((t) => String(t.id));
    if (!ids.length) return rows;
    note("Reading " + ids.length + " task" + (ids.length === 1 ? "" : "s") + " from ClickUp…");
    let res = null;
    try { res = await chrome.runtime.sendMessage({ type: "CLICKUP_EXPORT_SUBTASKS", taskIds: ids, includeSubtasks: !!includeSubtasks }); } catch (e) { res = null; }
    if (res && res.missed) note(res.missed + " task" + (res.missed === 1 ? "" : "s") + " couldn't be read (ClickUp rate limit) - their info may be blank.");
    const subsOf = (includeSubtasks && res && res.ok && res.subtasks) || {};
    const parentOf = (res && res.ok && res.parents) || {};
    const detailOf = (res && res.ok && res.details) || {};
    // Task info / status / due come from ClickUp itself, not the cached row.
    rows = rows.map((t) => {
      const d = detailOf[String(t.id)];
      return d ? { ...t, info: d.description, status: d.status || t.status, dueDateMs: d.dueDateMs != null ? d.dueDateMs : t.dueDateMs, done: d.done } : t;
    });
    const byId = new Map(rows.map((t) => [String(t.id), t]));
    const kids = new Map(); // parent id -> child rows, in the order they appear
    const top = [];
    for (const t of rows) {
      const p = parentOf[String(t.id)] || (t.parentId != null ? String(t.parentId) : null);
      if (p && byId.has(p)) {
        if (!kids.has(p)) kids.set(p, []);
        kids.get(p).push({ ...t, isSubtask: true });
      } else {
        top.push({ ...t, isSubtask: false });
      }
    }
    const out = [];
    for (const t of top) {
      out.push(t);
      const listed = new Set((kids.get(String(t.id)) || []).map((k) => String(k.id)));
      for (const k of kids.get(String(t.id)) || []) out.push(k);
      // Subtasks that weren't in the view get added under their parent too.
      for (const s of subsOf[String(t.id)] || []) {
        if (listed.has(String(s.id)) || byId.has(String(s.id))) continue;
        const d = detailOf[String(s.id)] || null; // subtasks need their own fetch for the description
        out.push({ ...s, ...(d || {}), info: (d && d.description) || s.description || "", isSubtask: true, client: t.client });
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
    const sub = menu.querySelector(".xp-sub");
    sub.textContent = data.rows.length + " task" + (data.rows.length === 1 ? "" : "s") + " · " + (data.title || "current view");
    if (!data.rows.length) {
      sub.style.color = "var(--red)";
      sub.textContent += " - nothing to export. Close this, change the filter (the list above is what gets exported), then try again.";
    }

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
    const share = mkOpt("Google: anyone with the link can view", true);
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
        if (!d.rows.length) throw new Error("This view has no tasks (" + (d.title || "current view") + "), so there is nothing to export.");
        let rows = d.rows.slice();
        rows = await withSubtasks(rows, note, subs.checked);
        const m = toMatrix(rows);
        const title = d.title || "tasks";
        const file = safeName(title) + "_" + new Date().toISOString().slice(0, 10);
        if (kind === "csv") { download(file + ".csv", "text/csv;charset=utf-8", "﻿" + toCsv(m)); note("Saved " + file + ".csv"); }
        else if (kind === "xls") { download(file + ".xls", "application/vnd.ms-excel", toHtml(m, title)); note("Saved " + file + ".xls (opens in Excel)"); }
        else if (kind === "md") {
          const text = toMarkdown(rows, title);
          download(file + ".md", "text/markdown;charset=utf-8", text);
          try { navigator.clipboard.writeText(text).then(() => note("Saved " + file + ".md and copied to the clipboard")).catch(() => note("Saved " + file + ".md")); }
          catch (e) { note("Saved " + file + ".md"); }
        }
        else {
          note("Creating in Google Drive…");
          const res = await chrome.runtime.sendMessage({
            type: "EXPORT_TO_GOOGLE", kind, name: file, share: share.checked,
            html: toDocHtml(rows, title), // Docs: headings + bullets
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
    for (const [kind, label] of [["csv", "📄 CSV file"], ["xls", "📊 Excel file (.xls)"], ["md", "📑 Markdown (.md)"], ["sheets", "🟩 Google Sheets"], ["docs", "📝 Google Docs"]]) {
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
