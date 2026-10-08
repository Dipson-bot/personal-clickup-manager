// @mention suggestions in every box that posts to ClickUp: the task comment box
// (formatted editor), waiting comments, Bulk edit's comment, and the floating
// timer's bigger comment box. Type "@" and a few letters - the workspace people who
// match are listed; ↑/↓ and Enter (or Tab, or a click) put in "@Full Name ",
// which is exactly what the comment matches to a real ClickUp mention when it
// is posted. People come from the roster the extension already keeps
// (CLICKUP_DEPT_DATA) - no ClickUp request per keystroke.
(() => {
  "use strict";
  if (window.PcmMention) return;
  // (The floating timer's one-line box #fCmt keeps its own "Tab → @name" hint: a
  // list wouldn't fit in that small window.)
  const BOXES = "textarea.pcm-cmt, #bkCommentOwn, #bkCommentWhy, #eComment, [data-mention]";
  const Q_RE = /(^|[\s(\[{,;:])@([\p{L}][\p{L}\p{N}._'-]*(?: [\p{L}][\p{L}\p{N}._'-]*)?)?$/u;
  let roster = null, rosterAt = 0, rosterP = null;
  function people() {
    if (roster && Date.now() - rosterAt < 10 * 60000) return Promise.resolve(roster);
    if (rosterP) return rosterP;
    rosterP = new Promise((res) => {
      try {
        chrome.runtime.sendMessage({ type: "CLICKUP_DEPT_DATA" }, (r) => {
          void chrome.runtime.lastError;
          const ms = r && r.ok && Array.isArray(r.members) ? r.members : [];
          if (ms.length) { roster = ms.map((m) => ({ id: String(m.id), name: String(m.name || m.username || m.email || "").trim(), email: String(m.email || "") })).filter((p) => p.name); rosterAt = Date.now(); }
          rosterP = null;
          res(roster || []);
        });
      } catch (e) { rosterP = null; res(roster || []); }
    });
    return rosterP;
  }
  const initials = (n) => { const w = String(n).split(/\s+/).filter(Boolean); return (w.length > 1 ? w[0][0] + w[w.length - 1][0] : String(n).slice(0, 2)).toUpperCase(); };
  const hue = (k) => { let h = 0; for (const ch of String(k)) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return "hsl(" + (h % 360) + ", 55%, 42%)"; };

  // The comment box an event happened in (a plain box, or the formatted editor
  // that stands in for a .pcm-cmt textarea).
  function boxOf(el) {
    if (!el || !el.closest) return null;
    if ((el.tagName === "TEXTAREA" || el.tagName === "INPUT") && el.matches(BOXES)) return { el, ce: false };
    const area = el.closest(".md-area");
    if (area) {
      const ed = area.closest(".md-ed-for");
      const ta = ed && ed.previousElementSibling;
      if (ta && ta.matches && ta.matches(BOXES)) return { el: area, ce: true };
    }
    return null;
  }
  // The text right before the caret.
  function before(box, doc) {
    if (!box.ce) return box.el.value.slice(0, box.el.selectionStart || 0);
    const sel = doc.getSelection();
    if (!sel || !sel.rangeCount) return "";
    const r = sel.getRangeAt(0);
    if (!box.el.contains(r.startContainer)) return "";
    const pre = doc.createRange();
    pre.selectNodeContents(box.el);
    pre.setEnd(r.startContainer, r.startOffset);
    return pre.toString();
  }

  const docs = new WeakSet();
  function attach(doc) {
    if (!doc || docs.has(doc)) return;
    docs.add(doc);
    const css = doc.createElement("style");
    css.textContent = `
    .pcm-mn { position: fixed; z-index: 2147483600; min-width: 220px; max-width: 320px; max-height: 240px; overflow: auto; background: var(--card, #fff); color: var(--text, #111); border: 1px solid var(--border, #ddd); border-radius: 10px; box-shadow: 0 12px 28px rgba(0,0,0,.22); padding: 4px; font: 12.5px system-ui, sans-serif; }
    .pcm-mn .o { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border-radius: 7px; cursor: pointer; }
    .pcm-mn .o.on, .pcm-mn .o:hover { background: rgba(99,102,241,.14); }
    .pcm-mn .av { width: 22px; height: 22px; border-radius: 50%; color: #fff; font-size: 9.5px; font-weight: 700; display: grid; place-items: center; flex: none; }
    .pcm-mn .nm { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .pcm-mn .em { color: var(--muted, #777); font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .pcm-mn .hd { padding: 4px 8px 2px; font-size: 10.5px; color: var(--muted, #777); }`;
    (doc.head || doc.documentElement).appendChild(css);
    let menu = null, box = null, q = null, hits = [], on = 0;
    const close = () => { if (menu) { menu.remove(); menu = null; } hits = []; };
    function place() {
      let rect = null;
      if (box.ce) { const s = doc.getSelection(); if (s && s.rangeCount) { const rs = s.getRangeAt(0).getClientRects(); rect = rs[rs.length - 1] || null; } }
      // A caret with no box of its own (start of a line) reads as 0,0: use the box.
      if (rect && !rect.top && !rect.bottom && !rect.left) rect = null;
      if (!rect) { const b = box.el.getBoundingClientRect(); rect = { left: b.left + 8, bottom: b.bottom, top: b.top }; }
      const vw = doc.defaultView.innerWidth, vh = doc.defaultView.innerHeight;
      const h = Math.min(240, menu.offsetHeight || 200);
      menu.style.left = Math.max(4, Math.min(rect.left, vw - menu.offsetWidth - 4)) + "px";
      menu.style.top = (rect.bottom + h + 6 > vh ? Math.max(4, rect.top - h - 4) : rect.bottom + 4) + "px";
    }
    function paint() {
      if (!hits.length) { close(); return; }
      if (!menu) { menu = doc.createElement("div"); menu.className = "pcm-mn"; menu.setAttribute("role", "listbox"); doc.body.appendChild(menu); menu.addEventListener("mousedown", (e) => { e.preventDefault(); const o = e.target.closest(".o"); if (o) pick(Number(o.dataset.i)); }); }
      menu.innerHTML = '<div class="hd">Mention someone - ↑↓ then Enter</div>' + hits.map((p, i) =>
        '<div class="o' + (i === on ? " on" : "") + '" role="option" data-i="' + i + '"><span class="av" style="background:' + hue(p.id) + '">' + initials(p.name).replace(/</g, "") + '</span><span style="min-width:0"><div class="nm"></div><div class="em"></div></span></div>').join("");
      menu.querySelectorAll(".o").forEach((o, i) => { o.querySelector(".nm").textContent = hits[i].name; o.querySelector(".em").textContent = hits[i].email; });
      place();
      const cur = menu.querySelector(".o.on"); if (cur) cur.scrollIntoView({ block: "nearest" });
    }
    async function update(target) {
      const b = boxOf(target);
      if (!b) { close(); return; }
      const m = Q_RE.exec(before(b, doc));
      if (!m) { close(); return; }
      box = b; q = m[2] || "";
      const list = await people();
      const n = q.toLowerCase();
      hits = list.filter((p) => { const nm = p.name.toLowerCase(); return !n || nm.startsWith(n) || nm.split(/\s+/).some((w) => w.startsWith(n)) || p.email.toLowerCase().startsWith(n); }).slice(0, 8);
      // "@Sam Rivera done" - a finished name followed by a space and more words: stop offering.
      if (!hits.length && /\s/.test(q)) { close(); return; }
      on = Math.min(on, Math.max(0, hits.length - 1));
      if (!hits.length) { hits = []; if (menu) { menu.innerHTML = '<div class="hd">' + (list.length ? "No one in the workspace matches “@" + q.replace(/</g, "") + "”" : "Loading the people list…") + "</div>"; place(); } else { menu = doc.createElement("div"); menu.className = "pcm-mn"; doc.body.appendChild(menu); menu.innerHTML = '<div class="hd">' + (list.length ? "No one in the workspace matches “@" + q.replace(/</g, "") + "”" : "Loading the people list…") + "</div>"; place(); } return; }
      paint();
    }
    function pick(i) {
      const p = hits[i];
      if (!p || !box) return;
      const ins = "@" + p.name + " ";
      if (!box.ce) {
        const el = box.el, end = el.selectionStart || 0, start = end - q.length - 1;
        el.value = el.value.slice(0, start) + ins + el.value.slice(end);
        el.selectionStart = el.selectionEnd = start + ins.length;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.focus();
      } else {
        const sel = doc.getSelection();
        const r = sel.getRangeAt(0);
        // Select the "@query" just typed (it sits in the text node at the caret).
        if (r.startContainer.nodeType === 3 && r.startOffset >= q.length + 1) {
          const rr = doc.createRange();
          rr.setStart(r.startContainer, r.startOffset - q.length - 1);
          rr.setEnd(r.startContainer, r.startOffset);
          sel.removeAllRanges(); sel.addRange(rr);
        }
        doc.execCommand("insertText", false, ins);
      }
      close();
    }
    doc.addEventListener("input", (e) => {
      // The hidden box behind a formatted editor echoes every keystroke: the
      // editor itself is what's being typed in.
      if (e.target && e.target._mdEd) return;
      on = 0; update(e.target);
    }, true);
    // Stay next to the caret when the page or a list scrolls.
    doc.addEventListener("scroll", () => { if (menu && box) place(); }, true);
    doc.defaultView.addEventListener("resize", () => { if (menu && box) place(); });
    doc.addEventListener("click", (e) => { if (menu && !menu.contains(e.target)) { const b = boxOf(e.target); if (b) update(e.target); else close(); } }, true);
    doc.addEventListener("focusout", () => setTimeout(() => { const a = doc.activeElement; if (!a || !boxOf(a)) close(); }, 150), true);
    // Capture phase: runs before the box's own Enter / Ctrl+Enter (post) handlers.
    doc.addEventListener("keydown", (e) => {
      if (!menu) return;
      if (e.key === "Escape") { e.preventDefault(); e.stopImmediatePropagation(); close(); return; }
      if (!hits.length) return;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); e.stopImmediatePropagation(); on = (on + (e.key === "ArrowDown" ? 1 : hits.length - 1)) % hits.length; paint(); }
      else if ((e.key === "Enter" && !e.ctrlKey && !e.metaKey && !e.shiftKey) || e.key === "Tab") { e.preventDefault(); e.stopImmediatePropagation(); pick(on); }
    }, true);
  }
  window.PcmMention = { attach, _people: people };
  attach(document);
})();
