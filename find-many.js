// Explore tasks › Find these tasks: paste any task names (one per line, with or
// without bullets) and find them among every task the user can see in ClickUp -
// any client, anyone's, open or closed. ClickUp's API has no text search, so the
// background keeps a task index (IndexedDB "pcm-taskindex", CLICKUP_TASK_INDEX)
// and the matching runs here. options.js shows the matched tasks as Explore's
// rows (so Export, details and the rest work); this file parses, matches and
// draws the checklist of pasted lines.
(function () {
  // ---- Parsing the pasted text ----
  // Every line is a task to find. Headings are optional: a line MAY be one - a
  // line ending in ":", a line without a bullet among bulleted ones, or (no
  // bullets at all) a short line above a longer one. Such a line stays a task
  // when it closely matches a real task (findList decides); otherwise it labels
  // the lines under it.
  const BULLET = /^\s*(?:[*\-•·▪◦‣–—]|\d{1,3}[.)]|[a-z][.)])\s+/i;
  const nWords = (s) => String(s).trim().split(/\s+/).filter(Boolean).length;
  function parseLines(text) {
    const lines = String(text || "").split(/\r?\n/).map((l) => l.replace(/\s+$/, "")).filter((l) => l.trim());
    const hasBullets = lines.some((l) => BULLET.test(l));
    const out = [];
    lines.forEach((raw, i) => {
      const t = raw.replace(BULLET, "").trim();
      if (!t) return;
      const bullet = BULLET.test(raw);
      const next = lines[i + 1];
      let cand = "";
      if (!bullet && /:\s*$/.test(t)) cand = "colon";
      else if (hasBullets && !bullet) cand = "plain";
      else if (!hasBullets && nWords(t) <= 3 && t.length <= 40 && !/[.!?]$/.test(t) && next != null && nWords(next.replace(BULLET, "")) >= 4) cand = "short";
      out.push({ text: t.replace(/:\s*$/, ""), cand });
    });
    return out;
  }
  // Without tasks to compare against: every possible heading is taken as one.
  function parseList(text) {
    const items = [];
    let section = "";
    for (const e of parseLines(text)) { if (e.cand) section = e.text; else items.push({ text: e.text, section }); }
    return items;
  }

  // Task names saved through a wrong text encoding show "â€”" for "—", "â€™"
  // for "’" … Such stretches are turned back into what was typed.
  const CP1252 = { 0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85, 0x2020: 0x86, 0x2021: 0x87, 0x02c6: 0x88, 0x2030: 0x89, 0x0160: 0x8a, 0x2039: 0x8b, 0x0152: 0x8c, 0x017d: 0x8e,
    0x2018: 0x91, 0x2019: 0x92, 0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97, 0x02dc: 0x98, 0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b, 0x0153: 0x9c, 0x017e: 0x9e, 0x0178: 0x9f };
  const MOJI_TAIL = "[\\u0080-\\u00bf\\u0152-\\u0192\\u02c6-\\u02dc\\u2013-\\u2122]";
  const MOJI_TEST = new RegExp("[\\u00c2\\u00c3\\u00e2]" + MOJI_TAIL);
  const MOJI_RUN = new RegExp("[\\u00c2-\\u00f4]" + MOJI_TAIL + "{1,3}", "g");
  function fixText(s) {
    s = String(s == null ? "" : s);
    if (!MOJI_TEST.test(s)) return s;
    return s.replace(MOJI_RUN, (m) => {
      const bytes = [];
      for (const ch of m) {
        const c = ch.charCodeAt(0);
        if (c < 0x100) bytes.push(c); else if (CP1252[c] != null) bytes.push(CP1252[c]); else return m;
      }
      try { return new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(bytes)); } catch (e) { return m; }
    });
  }

  // ---- Matching ----
  const STOP = new Set(("a an the and or of to for in on at by with from into across including include all any this that these those " +
    "is are be our its it as via per vs etc e g ie").split(" "));
  function words(s) {
    return fixText(s)
      .replace(/([a-z])([A-Z])/g, "$1 $2") // aggregateRating -> aggregate Rating
      .toLowerCase().replace(/&/g, " and ")
      .replace(/[^a-z0-9]+/g, " ").trim().split(/\s+/)
      .filter((w) => w && !STOP.has(w))
      .map((w) => (w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w));
  }
  // Same word, or the same stem: "caching" ~ "cache", "conflicting" ~ "conflict".
  function same(a, b) {
    if (a === b) return true;
    const m = Math.min(a.length, b.length);
    if (m < 4) return false;
    let p = 0;
    while (p < m && a[p] === b[p]) p++;
    return p >= 4 && p >= 0.7 * m;
  }
  // Word -> tasks lookup, so tens of thousands of tasks match in a blink.
  function buildIndex(tasks) {
    const docs = (tasks || []).map((t) => { const w = words(t.name); return { t, w: [...new Set(w)], flat: w.join(" ") }; });
    const post = new Map();
    docs.forEach((d, i) => { for (const w of d.w) { let p = post.get(w); if (!p) post.set(w, (p = [])); p.push(i); } });
    return { docs, post, vocab: [...post.keys()], N: Math.max(1, docs.length) };
  }
  // items: [{ text, … }]. Each comes back with .matches (best first, score 0-1),
  // .pick (the best when it's good enough) and .sure.
  const FOUND = 0.55, MAYBE = 0.35, TASK_NOT_HEADING = 0.8;
  function matchItems(items, tasks, ix) {
    ix = ix || buildIndex(tasks);
    const { docs, post, vocab, N } = ix;
    const wt = (w) => Math.log(1 + N / (1 + ((post.get(w) || []).length)));
    const simCache = new Map();
    const similar = (w) => { let s = simCache.get(w); if (!s) { s = new Set(vocab.filter((v) => same(w, v))); simCache.set(w, s); } return s; };
    return (items || []).map((it) => {
      const iw = [...new Set(words(it.text))];
      const flat = words(it.text).join(" ");
      const iTot = iw.reduce((s, w) => s + wt(w), 0) || 1;
      const sims = iw.map(similar);
      const anySim = new Set(); for (const s of sims) for (const v of s) anySim.add(v);
      const cand = new Set(); for (const v of anySim) for (const i of post.get(v)) cand.add(i);
      const scored = [];
      for (const i of cand) {
        const d = docs[i];
        let rec = 0, prec = 0, dTot = 0;
        iw.forEach((w, k) => { if (d.w.some((x) => sims[k].has(x))) rec += wt(w); });
        for (const x of d.w) { const v = wt(x); dTot += v; if (anySim.has(x)) prec += v; }
        let score = 0.7 * (rec / iTot) + 0.3 * (prec / (dTot || 1));
        const short = flat.length < d.flat.length ? flat : d.flat, long = short === flat ? d.flat : flat;
        if (short.split(" ").length >= 3 && long.includes(short)) score = Math.max(score, 0.95);
        if (flat && flat === d.flat) score = 1;
        if (score >= 0.25) scored.push({ task: d.t, score: Math.round(score * 100) / 100, cover: dTot ? prec / dTot : 0 });
      }
      scored.sort((a, b) => b.score - a.score || (b.task.updatedAt || 0) - (a.task.updatedAt || 0));
      const matches = scored.slice(0, 5);
      const pick = matches[0] && matches[0].score >= MAYBE ? matches[0] : null;
      return { ...it, matches, pick, sure: !!(pick && pick.score >= FOUND) };
    });
  }
  // The whole job: lines -> found tasks, with sections. picks: { "<line>": taskId
  // | null } - the user's own choice ("Use: …" / "None of these") wins.
  function findList(text, tasks, picks) {
    const entries = parseLines(text);
    const ix = buildIndex(tasks);
    const res = matchItems(entries, tasks, ix);
    const byId = new Map((tasks || []).map((t) => [String(t.id), t]));
    const out = [];
    let section = "";
    for (const r of res) {
      const own = picks && Object.prototype.hasOwnProperty.call(picks, r.text) ? picks[r.text] : undefined;
      // A possible heading that is really a task stays a task: it matches closely
      // AND covers nearly all of that task's name ("Technical" is not "Technical
      // Monthly Report"; "Keyword research" is "Keyword research").
      const isTask = r.pick && r.pick.score >= TASK_NOT_HEADING && r.pick.cover >= 0.8;
      if (r.cand && own === undefined && (r.cand === "colon" || !isTask)) { section = r.text; continue; }
      const item = { text: r.text, section, matches: r.matches, pick: r.pick, sure: r.sure, heading: !!r.cand };
      if (own === null) { item.pick = null; item.sure = false; item.chosen = true; }
      else if (own != null && byId.has(String(own))) { item.pick = { task: byId.get(String(own)), score: 1 }; item.sure = true; item.chosen = true; }
      out.push(item);
    }
    return out;
  }

  // ---- Status words ----
  const fmtDay = (ms) => new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric", year: new Date(ms).getFullYear() === new Date().getFullYear() ? undefined : "numeric" });
  const cap = (s) => String(s || "").replace(/^./, (c) => c.toUpperCase());
  function statusWord(t) {
    if (!t) return "Not found in ClickUp";
    if (t.done) return "Done" + (t.doneAt ? " " + fmtDay(t.doneAt) : "");
    return cap(t.status || "open") + (t.dueDateMs ? " - due " + fmtDay(t.dueDateMs) : "");
  }
  function statusKind(t) {
    if (!t) return "none";
    if (t.done) return "done";
    if (/progress|review|qa|working|doing|revision|approval/i.test(t.status || "")) return "doing";
    return "todo";
  }
  const ICON = { done: "✅", doing: "🔄", todo: "⏳", none: "❓" };
  const who = (t) => (t && Array.isArray(t.assignees) ? t.assignees.map((a) => (a && typeof a === "object" ? a.username : a)).filter(Boolean).join(", ") : "");

  // ---- Copying ----
  function tableRows(res) {
    return res.map((r) => {
      const t = r.pick && r.pick.task;
      return [r.section || "", r.text, t ? fixText(t.name) : "", statusWord(t), t ? who(t) : "", t ? t.url : ""];
    });
  }
  const HEAD = ["Section", "Pasted line", "ClickUp task", "Status", "Assignee", "Link"];
  function toTsv(res) {
    const clean = (v) => String(v).replace(/[\t\r\n]+/g, " ");
    return [HEAD].concat(tableRows(res)).map((r) => r.map(clean).join("\t")).join("\n");
  }
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  function toHtml(res) {
    const rows = tableRows(res).map((r) => "<tr>" + r.map((v, i) => "<td>" + (i === 5 && v ? '<a href="' + esc(v) + '">' + esc(v) + "</a>" : esc(v)) + "</td>").join("") + "</tr>").join("");
    return '<table border="1" cellpadding="4" style="border-collapse:collapse"><tr>' + HEAD.map((h) => "<th>" + h + "</th>").join("") + "</tr>" + rows + "</table>";
  }
  function toReport(res) {
    const out = [];
    let sec = null;
    for (const r of res) {
      if (r.section !== sec) { sec = r.section; if (sec) out.push((out.length ? "\n" : "") + sec); }
      const t = r.pick && r.pick.task;
      out.push("- " + ICON[statusKind(t)] + " " + r.text + " - " + statusWord(t));
    }
    return out.join("\n");
  }

  const API = { parseLines, parseList, findList, matchItems, buildIndex, fixText, words, same, statusWord, statusKind, toTsv, toHtml, toReport, FOUND, MAYBE, TASK_NOT_HEADING };
  if (typeof module !== "undefined" && module.exports) module.exports = API;
  if (typeof document === "undefined") return;
  window.PcmFindMany = API;

  // ---- Reading the index (the background writes it; this page only reads) ----
  let memo = null; // { key, tasks } - not re-read while the index hasn't changed
  API.readIndex = function readIndex(meta) {
    const key = meta ? [meta.count, meta.lastSync, meta.read].join("|") : "";
    if (memo && memo.key === key && key) return Promise.resolve(memo.tasks);
    return new Promise((resolve) => {
      let r;
      try { r = indexedDB.open("pcm-taskindex", 1); } catch (e) { resolve([]); return; }
      r.onupgradeneeded = () => { if (!r.result.objectStoreNames.contains("tasks")) r.result.createObjectStore("tasks", { keyPath: "id" }); };
      r.onerror = () => resolve([]);
      r.onsuccess = () => {
        try {
          const q = r.result.transaction("tasks").objectStore("tasks").getAll();
          q.onsuccess = () => { const tasks = (q.result || []).map((t) => ({ ...t, name: fixText(t.name) })); memo = { key, tasks }; resolve(tasks); };
          q.onerror = () => resolve([]);
        } catch (e) { resolve([]); }
      };
    });
  };
  // "12,340 tasks · updated 3 min ago" / "Indexing… 4,300 so far"
  API.indexStatus = function indexStatus(m) {
    if (!m) return "Not indexed yet - the first Find reads every ClickUp task you can see (once).";
    const n = (x) => Number(x || 0).toLocaleString();
    if (m.state !== "ready") return "Indexing your ClickUp tasks… " + n(m.read) + " so far" + (m.error ? " - paused: " + (m.error === "rate-limited" ? "ClickUp asked to slow down. Press Load tasks to carry on." : m.error) : "");
    const ago = Math.max(0, Math.round((Date.now() - (m.lastSync || 0)) / 60000));
    return "Task index: " + n(m.count) + " tasks · updated " + (ago < 1 ? "just now" : ago < 60 ? ago + " min ago" : Math.round(ago / 60) + " h ago");
  };

  // ---- The checklist of pasted lines (Explore draws the task rows) ----
  const css = document.createElement("style");
  css.textContent = `
    .fm-list { margin: 6px 0 10px; border: 1px solid var(--border); border-radius: 10px; padding: 6px 10px 8px; }
    .fm-list > summary { cursor: pointer; font-weight: 700; font-size: 12.5px; padding: 2px 0; }
    .fm-sec { margin: 10px 0 2px; font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); font-weight: 700; }
    .fm-it { display: grid; grid-template-columns: 22px 1fr; gap: 0 6px; padding: 5px 0; border-top: 1px solid var(--border); font-size: 12.5px; }
    .fm-sec + .fm-it, .fm-list > summary + .fm-it { border-top: 0; }
    .fm-ic { text-align: center; }
    .fm-q { font-weight: 600; }
    .fm-m { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; margin-top: 2px; color: var(--muted); font-size: 12px; }
    .fm-m a { color: var(--indigo); text-decoration: none; }
    .fm-m a:hover { text-decoration: underline; }
    .fm-chip { padding: 0 7px; border-radius: 999px; border: 1px solid var(--border); font-size: 11px; font-weight: 600; white-space: nowrap; color: var(--text); }
    .fm-chip.done { color: var(--green); border-color: currentColor; }
    .fm-chip.doing { color: var(--blue, var(--indigo)); border-color: currentColor; }
    .fm-chip.maybe { color: var(--amber); border-color: currentColor; }
    .fm-none { color: var(--red); }
    .fm-alt { font-size: 11.5px; margin-top: 2px; }
    .fm-alt summary { cursor: pointer; color: var(--muted); }
    .fm-alt button { display: block; text-align: left; width: 100%; font: inherit; font-size: 12px; padding: 3px 6px; border: 0; border-radius: 6px; background: none; color: var(--text); cursor: pointer; }
    .fm-alt button:hover { background: var(--bg2); }
    .fm-foot { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-top: 8px; }
    .fm-foot .fm-note { font-size: 11.5px; color: var(--muted); }
  `;
  document.head.appendChild(css);
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

  // opts: { scope: "Acme Dental" | "", searched: n, onPick(line, taskId|null) }
  API.renderChecklist = function renderChecklist(res, opts = {}) {
    const box = el("details", "fm-list");
    box.open = true;
    const found = res.filter((r) => r.pick).length;
    box.appendChild(el("summary", "", "Your list - " + found + " of " + res.length + " found"));
    let sec = null;
    res.forEach((r) => {
      if (r.section !== sec) { sec = r.section; if (sec) box.appendChild(el("div", "fm-sec", sec)); }
      const t = r.pick && r.pick.task;
      const k = statusKind(t);
      const it = el("div", "fm-it");
      it.appendChild(el("span", "fm-ic", ICON[k]));
      const body = el("div");
      body.appendChild(el("div", "fm-q", r.text));
      const m = el("div", "fm-m");
      if (t) {
        const a = el("a", "", fixText(t.name)); a.href = t.url; a.target = "_blank"; a.rel = "noopener";
        m.append(a, el("span", "fm-chip " + k, statusWord(t)));
        if (!r.sure) { const c = el("span", "fm-chip maybe", "close match - check it"); c.title = "The words only partly match. Open it, or pick another task below."; m.appendChild(c); }
        const bits = [who(t) || "unassigned", t.client || t.list].filter(Boolean);
        m.appendChild(el("span", "", bits.join(" · ")));
      } else m.appendChild(el("span", "fm-none", r.chosen ? "Marked not found" : "Not found" + (opts.scope ? " in " + opts.scope : "") + " among " + Number(opts.searched || 0).toLocaleString() + " tasks - not in ClickUp yet, named very differently, or outside the choices above."));
      body.appendChild(m);
      const others = (r.matches || []).filter((x) => !t || String(x.task.id) !== String(t.id));
      if (others.length || t || r.chosen) {
        const d = el("details", "fm-alt");
        d.appendChild(el("summary", "", others.length ? (t ? "Not this one? " : "") + others.length + " other possible task" + (others.length === 1 ? "" : "s") : "Not this one?"));
        for (const o of others) {
          const b = el("button", "", "Use: " + fixText(o.task.name) + " (" + statusWord(o.task) + ")");
          b.onclick = () => opts.onPick && opts.onPick(r.text, String(o.task.id));
          d.appendChild(b);
        }
        if (t) { const b = el("button", "", "None of these - mark not found"); b.onclick = () => opts.onPick && opts.onPick(r.text, null); d.appendChild(b); }
        if (r.chosen) { const b = el("button", "", "↺ Back to the automatic match"); b.onclick = () => opts.onPick && opts.onPick(r.text, undefined); d.appendChild(b); }
        body.appendChild(d);
      }
      it.appendChild(body);
      box.appendChild(it);
    });
    const foot = el("div", "fm-foot");
    const c1 = el("button", "cu-filter-btn", "Copy table"); c1.type = "button"; c1.title = "Your list as a table for Google Sheets or Docs: section, pasted line, ClickUp task, status, assignee, link";
    const c2 = el("button", "cu-filter-btn", "Copy for report"); c2.type = "button"; c2.title = "Plain text by section: each line with ✅ done / 🔄 in progress / ⏳ to do / ❓ not found";
    const note = el("span", "fm-note");
    c1.onclick = async () => {
      try { await navigator.clipboard.write([new ClipboardItem({ "text/plain": new Blob([toTsv(res)], { type: "text/plain" }), "text/html": new Blob([toHtml(res)], { type: "text/html" }) })]); }
      catch (e) { try { await navigator.clipboard.writeText(toTsv(res)); } catch (e2) { note.textContent = "Couldn't copy."; return; } }
      note.textContent = "Copied - paste into a Sheet or Doc.";
    };
    c2.onclick = async () => { try { await navigator.clipboard.writeText(toReport(res)); note.textContent = "Copied."; } catch (e) { note.textContent = "Couldn't copy."; } };
    foot.append(c1, c2, note, el("span", "fm-note", "⤓ Export above exports the tasks found, with their links."));
    box.appendChild(foot);
    return box;
  };
})();
