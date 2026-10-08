// Formatted notes (task notes and client notes).
// Text pasted from Claude, ChatGPT, Grok or a web page arrives as formatted HTML;
// the note boxes are plain text, so it used to collapse into one run of words.
//  - Paste: when the clipboard carries formatting, it is turned into Markdown
//    (headings, **bold**, ~~strike~~, `code`, nested lists, [x] checkboxes,
//    tables, links, quotes) and inserted at the cursor. Text copied with an AI's
//    own "Copy" button is usually Markdown already and pastes as it is.
//  - Display: a saved note's Markdown is shown formatted. Everything is escaped
//    first and only http(s) links become anchors, so a note can never inject
//    markup or script.
// Loaded before task-notes.js and task-files.js; window.PcmMd.
(() => {
  "use strict";
  const esc = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

  // ---------- HTML (clipboard) -> Markdown ----------
  const SKIP = new Set(["SCRIPT", "STYLE", "BUTTON", "SVG", "NOSCRIPT", "TEMPLATE", "HEAD", "META", "LINK", "TITLE"]);
  function inline(node) {
    let out = "";
    for (const n of node.childNodes) {
      if (n.nodeType === 3) { out += n.nodeValue.replace(/\s+/g, " "); continue; }
      if (n.nodeType !== 1 || SKIP.has(n.tagName)) continue;
      const t = n.tagName;
      const inner = () => inline(n);
      if (t === "BR") out += "\n";
      else if (t === "STRONG" || t === "B") { const s = inner().trim(); if (s) out += "**" + s + "**"; }
      else if (t === "EM" || t === "I") { const s = inner().trim(); if (s) out += "*" + s + "*"; }
      else if (t === "DEL" || t === "S" || t === "STRIKE") { const s = inner().trim(); if (s) out += "~~" + s + "~~"; }
      else if (t === "CODE") { const s = n.textContent; if (s) out += "`" + s.replace(/`/g, "'") + "`"; }
      else if (t === "A") { const s = inner().trim(), h = n.getAttribute("href") || ""; out += /^https?:\/\//i.test(h) && s && s !== h ? "[" + s + "](" + h + ")" : (s || h); }
      else if (t === "INPUT" && (n.type || "").toLowerCase() === "checkbox") out += n.checked || n.hasAttribute("checked") ? "[x] " : "[ ] ";
      // Our own rendered box (formatted editing).
      else if (n.classList && n.classList.contains("md-box")) out += /☑/.test(n.textContent) ? "[x] " : "[ ] ";
      else if (t === "IMG") { const a = n.getAttribute("alt"); if (a) out += a; }
      else if (/^(UL|OL|TABLE|PRE|BLOCKQUOTE|H[1-6]|P|DIV|HR)$/.test(t)) out += "\n" + block(n).trim() + "\n";
      else out += inner();
    }
    return out;
  }
  function listMd(list, depth) {
    const ordered = list.tagName === "OL";
    let i = Number(list.getAttribute("start")) || 1, out = "";
    for (const li of list.children) {
      if (li.tagName !== "LI") continue;
      const nested = [], parts = [];
      for (const c of li.childNodes) {
        if (c.nodeType === 1 && (c.tagName === "UL" || c.tagName === "OL")) nested.push(c);
        else parts.push(c);
      }
      const holder = li.cloneNode(false);
      for (const p of parts) holder.appendChild(p.cloneNode(true));
      let text = inline(holder).replace(/\n{2,}/g, "\n").trim().replace(/\n/g, "\n" + "  ".repeat(depth + 1));
      // A task-list item: keep its box at the front ("- [x] Step 3").
      const box = /^\[( |x)\]\s*/.exec(text);
      const bullet = ordered ? i++ + ". " : "- ";
      out += "  ".repeat(depth) + bullet + (box ? "[" + box[1] + "] " + text.slice(box[0].length) : text) + "\n";
      for (const n of nested) out += listMd(n, depth + 1);
    }
    return out;
  }
  function tableMd(tbl) {
    const rows = [...tbl.querySelectorAll("tr")].map((tr) => [...tr.children].map((c) => inline(c).replace(/\s+/g, " ").replace(/\|/g, "\\|").trim()));
    if (!rows.length) return "";
    const w = Math.max(...rows.map((r) => r.length));
    const line = (r) => "| " + Array.from({ length: w }, (_, k) => r[k] || "").join(" | ") + " |";
    return [line(rows[0]), "| " + Array.from({ length: w }, () => "---").join(" | ") + " |", ...rows.slice(1).map(line)].join("\n");
  }
  function block(node) {
    const t = node.tagName;
    if (/^H[1-6]$/.test(t)) return "#".repeat(Number(node.getAttribute("data-l")) || +t[1]) + " " + inline(node).replace(/\s+/g, " ").trim() + "\n\n";
    if (t === "UL" || t === "OL") return listMd(node, 0) + "\n";
    if (t === "TABLE") return tableMd(node) + "\n\n";
    if (t === "PRE") return "```\n" + node.textContent.replace(/\n$/, "") + "\n```\n\n";
    if (t === "HR") return "---\n\n";
    if (t === "BLOCKQUOTE") return blocks(node).trim().split("\n").map((l) => "> " + l).join("\n") + "\n\n";
    if (t === "P") return inline(node).trim() + "\n\n";
    return blocks(node);
  }
  function blocks(node) {
    let out = "", buf = "";
    const flush = () => { if (buf.trim()) out += buf.trim() + "\n\n"; buf = ""; };
    for (const n of node.childNodes) {
      if (n.nodeType === 3) { buf += n.nodeValue.replace(/\s+/g, " "); continue; }
      if (n.nodeType !== 1 || SKIP.has(n.tagName)) continue;
      if (/^(H[1-6]|UL|OL|TABLE|PRE|HR|BLOCKQUOTE|P|DIV|SECTION|ARTICLE|MAIN|HEADER|FOOTER|LI)$/.test(n.tagName)) { flush(); out += block(n); }
      else { const w = document.createElement("span"); w.appendChild(n.cloneNode(true)); buf += inline(w); }
    }
    flush();
    return out;
  }
  function fromHtml(html) {
    const doc = new DOMParser().parseFromString(String(html || ""), "text/html");
    return blocks(doc.body).replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  }
  // Worth converting: the HTML has real structure (not just one styled span).
  const formatted = (html) => /<(h[1-6]|ul|ol|li|table|pre|blockquote|strong|b|em|del|s|code|p|br|input)[\s>]/i.test(html || "");

  // ---------- Markdown -> safe HTML ----------
  function inl(s) {
    // Code spans first, held aside so nothing inside them is formatted.
    const codes = [];
    let t = String(s).replace(/`([^`]+)`/g, (m, c) => { codes.push(c); return "\u0000" + (codes.length - 1) + "\u0000"; });
    t = esc(t);
    t = t.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (m, txt, u) => '<a href="' + u + '" target="_blank" rel="noopener noreferrer">' + txt + "</a>");
    t = t.replace(/(^|[\s(])(https?:\/\/[^\s<>"')]+[^\s<>"').,;:!?])/g, (m, pre, u) => pre + '<a href="' + u + '" target="_blank" rel="noopener noreferrer">' + u + "</a>");
    t = t.replace(/\*\*([^*]+?)\*\*|__([^_]+?)__/g, (m, a, b) => "<strong>" + (a || b) + "</strong>");
    t = t.replace(/~~([^~]+?)~~/g, "<del>$1</del>");
    t = t.replace(/(^|[^*\w])\*([^*\s][^*]*?)\*(?!\w)/g, "$1<em>$2</em>");
    t = t.replace(/\u0000(\d+)\u0000/g, (m, i) => "<code>" + esc(codes[+i]) + "</code>");
    return t;
  }
  const URL_RX = /(^|[\s(])(https?:\/\/[^\s<>"')]+[^\s<>"').,;:!?])/g;
  function linkifyHtml(text) {
    return String(text).split("\n").map((line) => esc(line.replace(/^ /, "\u00a0").replace(/ $/, "\u00a0")).replace(URL_RX, (m, pre, u) => pre + '<a href="' + u + '" target="_blank" rel="noopener noreferrer">' + u + "</a>")).join("<br>");
  }
  function render(md) {
    const lines = String(md || "").replace(/\r\n?/g, "\n").split("\n");
    let out = "", i = 0;
    const para = [];
    const flushPara = () => { if (para.length) { out += "<p>" + para.map(inl).join("<br>") + "</p>"; para.length = 0; } };
    while (i < lines.length) {
      const L = lines[i];
      if (/^```/.test(L)) {
        flushPara();
        const code = [];
        i++;
        while (i < lines.length && !/^```/.test(lines[i])) code.push(lines[i++]);
        i++;
        out += "<pre><code>" + esc(code.join("\n")) + "</code></pre>";
        continue;
      }
      if (/^\s*$/.test(L)) { flushPara(); i++; continue; }
      let m;
      // Shown two sizes smaller (a note isn't a page); data-l keeps the real level
      // so editing in the formatted view can't push headings down a level each save.
      if ((m = /^(#{1,6})\s+(.*)$/.exec(L))) { flushPara(); const n = Math.min(6, m[1].length + 2); out += "<h" + n + ' data-l="' + m[1].length + '">' + inl(m[2]) + "</h" + n + ">"; i++; continue; }
      if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(L)) { flushPara(); out += "<hr>"; i++; continue; }
      if (/^\s*\|.*\|\s*$/.test(L) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
        flushPara();
        const cells = (r) => r.trim().replace(/^\||\|$/g, "").split(/(?<!\\)\|/).map((c) => c.replace(/\\\|/g, "|").trim());
        const head = cells(L);
        i += 2;
        let body = "";
        while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) { body += "<tr>" + cells(lines[i]).map((c) => "<td>" + inl(c) + "</td>").join("") + "</tr>"; i++; }
        out += '<div class="md-tw"><table><thead><tr>' + head.map((c) => "<th>" + inl(c) + "</th>").join("") + "</tr></thead><tbody>" + body + "</tbody></table></div>";
        continue;
      }
      if (/^\s*>/.test(L)) {
        flushPara();
        const q = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) q.push(lines[i++].replace(/^\s*>\s?/, ""));
        out += "<blockquote>" + render(q.join("\n")) + "</blockquote>";
        continue;
      }
      if (/^\s*(?:[-*+]|\d+[.)])\s+/.test(L)) {
        flushPara();
        // Nested lists by indentation.
        const items = [];
        while (i < lines.length && (/^\s*(?:[-*+]|\d+[.)])\s+/.test(lines[i]) || (/^\s{2,}\S/.test(lines[i]) && items.length))) {
          const mm = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i]);
          if (mm) items.push({ ind: mm[1].replace(/\t/g, "  ").length, ord: /\d/.test(mm[2]), text: mm[3] });
          else items[items.length - 1].text += "\n" + lines[i].trim();
          i++;
        }
        out += listHtml(items, 0, items.length ? items[0].ind : 0).html;
        continue;
      }
      para.push(L);
      i++;
    }
    flushPara();
    return out;
  }
  function listHtml(items, start, ind) {
    const ord = items[start] && items[start].ord;
    let html = ord ? "<ol>" : "<ul>", k = start;
    while (k < items.length && items[k].ind >= ind) {
      if (items[k].ind > ind) { const sub = listHtml(items, k, items[k].ind); html = html.replace(/<\/li>$/, "") + sub.html + "</li>"; k = sub.next; continue; }
      const it = items[k];
      const box = /^\[( |x|X)\]\s+/.exec(it.text);
      const body = (box ? it.text.slice(box[0].length) : it.text).split("\n").map(inl).join("<br>");
      const on = box && box[1] !== " ";
      html += box ? '<li class="md-task' + (on ? " done" : "") + '"><span class="md-box" role="checkbox" aria-checked="' + on + '" title="' + (on ? "Done - click to untick" : "Click to tick") + '" contenteditable="false">' + (on ? "☑" : "☐") + "</span>" + body + "</li>" : "<li>" + body + "</li>";
      k++;
    }
    return { html: html + (ord ? "</ol>" : "</ul>"), next: k };
  }

  // ---------- styles for rendered notes ----------
  const css = document.createElement("style");
  css.textContent = `
  .md, #tfList .tf-nt.md { white-space: normal; line-height: 1.5; overflow-wrap: anywhere; }
  .md > :first-child { margin-top: 0; } .md > :last-child { margin-bottom: 0; }
  .md p { margin: 0 0 6px; }
  .md h3, .md h4, .md h5, .md h6 { margin: 10px 0 4px; line-height: 1.3; }
  .md h3 { font-size: 15px; } .md h4 { font-size: 13.5px; } .md h5, .md h6 { font-size: 12.5px; }
  .md ul, .md ol { margin: 2px 0 6px; padding-left: 20px; }
  .md li { margin: 2px 0; }
  /* A block (not flex), so a nested list stays under its item, not beside it. */
  .md li.md-task { list-style: none; position: relative; padding-left: 2px; }
  .md .md-box { position: absolute; left: -18px; top: 0; font-size: 13px; color: var(--muted); }
  .md li.md-task.done .md-box { color: var(--green, #16a34a); }
  .md code { font: 11.5px ui-monospace, SFMono-Regular, Consolas, monospace; background: rgba(220,38,38,.08); color: var(--red, #dc2626); padding: 1px 4px; border-radius: 4px; }
  .md pre { background: var(--bg2, rgba(0,0,0,.05)); padding: 8px 10px; border-radius: 6px; overflow: auto; }
  .md pre code { background: none; color: inherit; padding: 0; }
  .md del { opacity: .65; }
  .md blockquote { margin: 4px 0; padding: 2px 10px; border-left: 3px solid var(--border); color: var(--muted); }
  .md hr { border: 0; border-top: 1px solid var(--border); margin: 8px 0; }
  .md .md-tw { overflow-x: auto; margin: 4px 0 8px; }
  .md table { border-collapse: collapse; font-size: 12px; min-width: 60%; }
  .md th, .md td { border: 1px solid var(--border); padding: 4px 8px; text-align: left; vertical-align: top; }
  .md th { background: var(--bg2, rgba(0,0,0,.04)); font-weight: 600; }
  .md a { color: var(--indigo, #6366f1); }
  `;
  document.head.appendChild(css);

  // ---------- paste into a note box ----------
  // Capture phase, before the boxes' own paste handlers (they only take files).
  const NOTE_BOXES = "textarea.tn-ta, textarea.tf-nin, textarea.tf-nein, textarea.md-raw, textarea.pcm-desc-ta";
  // Formatted clipboard -> Markdown at the cursor of a plain text box. True when
  // it handled the paste. Also used by the floating tracker's comment box.
  function pasteInto(e, ta) {
    const cd = e.clipboardData;
    if (!ta || !cd || (cd.files && cd.files.length)) return false;
    const html = cd.getData("text/html");
    if (!html || !formatted(html)) return false;
    const md = fromHtml(html);
    if (!md) return false;
    e.preventDefault();
    e.stopPropagation();
    const a = ta.selectionStart, b = ta.selectionEnd;
    const room = (Number(ta.maxLength) > 0 ? ta.maxLength : 1e9) - (ta.value.length - (b - a));
    ta.setRangeText(md.slice(0, Math.max(0, room)), a, b, "end");
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  }
  document.addEventListener("paste", (e) => {
    const ta = e.target && e.target.closest && e.target.closest(NOTE_BOXES);
    if (ta) pasteInto(e, ta);
  }, true);

  // Tick / untick the n-th checkbox (in reading order) of a note's Markdown.
  function toggleTask(md, n) {
    const lines = String(md || "").split("\n");
    let k = -1, fence = false;
    for (let i = 0; i < lines.length; i++) {
      if (/^```/.test(lines[i])) { fence = !fence; continue; }
      if (fence) continue;
      const m = /^((?:\s*>\s?)*\s*(?:[-*+]|\d+[.)])\s+)\[( |x|X)\](\s+)/.exec(lines[i]); // also inside a > quote
      if (!m || ++k !== n) continue;
      lines[i] = m[1] + "[" + (m[2] === " " ? "x" : " ") + "]" + lines[i].slice(m[1].length + 3);
      break;
    }
    return lines.join("\n");
  }

  // ---------- editing in the formatted view ----------
  // A contenteditable copy of the rendered note with a small toolbar. What is
  // saved is still Markdown (getMarkdown), so storage, Drive and the display
  // don't change. "Markdown" swaps to the raw text and back.
  function editor(md, opts) {
    const o = opts || {};
    const wrap = document.createElement("div");
    wrap.className = "md-ed";
    const BTN = [["b", "B", "Bold (Ctrl+B)", "bold"], ["i", "I", "Italic (Ctrl+I)", "italic"], ["s", "S", "Strikethrough", "strikeThrough"], ["code", "</>", "Code", "code"],
      ["ul", "• List", "Bullet list", "insertUnorderedList"], ["ol", "1. List", "Numbered list", "insertOrderedList"], ["box", "☐ Box", "Checkbox at the cursor", "box"]];
    wrap.innerHTML = '<div class="md-tb">' + BTN.map((b) => '<button type="button" data-cmd="' + b[3] + '" title="' + b[2] + '">' + esc(b[1]) + "</button>").join("") +
      '<span class="sp"></span><button type="button" data-raw title="Edit the raw Markdown text instead">Markdown</button></div>' +
      '<div class="md md-area" contenteditable="true" spellcheck="true"></div><textarea class="md-raw" hidden spellcheck="true"></textarea>';
    const area = wrap.querySelector(".md-area"), raw = wrap.querySelector(".md-raw");
    if (o.maxLength) raw.maxLength = o.maxLength;
    area.innerHTML = render(md);
    if (o.placeholder) area.setAttribute("data-ph", o.placeholder);
    let rawMode = false;
    const BOX = (on) => '<span class="md-box" role="checkbox" aria-checked="' + !!on + '" contenteditable="false">' + (on ? "☑" : "☐") + "</span>";
    // Enter in a checklist line copies the line's class but not its box: give
    // the new line an empty box (and drop a copied "done").
    const fixBoxes = () => {
      area.querySelectorAll("li.md-task").forEach((li) => {
        const b = li.querySelector(":scope > .md-box");
        if (!b) { li.insertAdjacentHTML("afterbegin", BOX(false)); li.classList.remove("done"); }
        else li.classList.toggle("done", /☑/.test(b.textContent));
      });
    };
    const get = () => rawMode ? raw.value : fromHtml(area.innerHTML);
    const changed = () => { if (o.onInput) o.onInput(get()); };
    area.addEventListener("focus", () => { try { document.execCommand("defaultParagraphSeparator", false, "p"); } catch (e) {} });
    area.addEventListener("input", () => { fixBoxes(); changed(); });
    // A typed web address becomes a link once a space / Enter follows it (or
    // when you leave the box). The cursor stays where it was.
    const autoLink = () => {
      const sel = window.getSelection();
      const caret = sel && sel.rangeCount && area.contains(sel.getRangeAt(0).startContainer) ? sel.getRangeAt(0) : null;
      const walker = document.createTreeWalker(area, NodeFilter.SHOW_TEXT);
      const hits = [];
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        if (n.parentElement && n.parentElement.closest("a, code, pre")) continue;
        URL_RX.lastIndex = 0;
        // Only an address that is complete (followed by a space or the end of a line someone left).
        if (/https?:\/\/\S+\s/.test(n.nodeValue) || (!caret && URL_RX.test(n.nodeValue))) hits.push(n);
      }
      let restore = null;
      for (const n of hits) {
        const keep = caret && caret.startContainer === n ? caret.startOffset : -1;
        const box = document.createElement("span");
        box.innerHTML = linkifyHtml(n.nodeValue.replace(/\u00a0/g, " "));
        const parts = [...box.childNodes];
        n.replaceWith(...parts);
        if (keep >= 0) {
          let left = keep;
          for (const part of parts) {
            const len = part.textContent.length;
            if (left <= len) { restore = part.nodeType === 3 ? [part, left] : [part.nextSibling || part, part.nextSibling ? 0 : 1]; break; }
            left -= len;
          }
        }
      }
      if (restore) { try { const r = document.createRange(); r.setStart(restore[0], Math.min(restore[1], restore[0].nodeType === 3 ? restore[0].nodeValue.length : restore[0].childNodes.length)); r.collapse(true); sel.removeAllRanges(); sel.addRange(r); } catch (e) {} }
      if (hits.length) changed();
    };
    area.addEventListener("blur", autoLink);
    area.addEventListener("keyup", (e) => { if (e.key === " " || e.key === "Enter") autoLink(); });
    raw.addEventListener("input", changed);
    area.addEventListener("click", (e) => {
      const a = e.target.closest("a[href]");
      if (a && (e.ctrlKey || e.metaKey)) { e.preventDefault(); window.open(a.href, "_blank", "noopener"); return; }
      const b = e.target.closest(".md-box");
      if (!b) return;
      const on = !/☑/.test(b.textContent);
      b.textContent = on ? "☑" : "☐";
      b.setAttribute("aria-checked", String(on));
      const li = b.closest("li"); if (li) li.classList.toggle("done", on);
      changed();
    });
    // Pasted formatting arrives as Markdown -> shown formatted at the cursor.
    area.addEventListener("paste", (e) => {
      const cd = e.clipboardData;
      if (!cd || (cd.files && cd.files.length)) return; // screenshots: the note's own handler
      const html = cd.getData("text/html"), text = cd.getData("text/plain");
      const md2 = html && formatted(html) ? fromHtml(html) : (/^\s*(#{1,6}\s|[-*+]\s|\d+[.)]\s|\|.*\||>\s|```)/m.test(text || "") ? text : "");
      e.preventDefault();
      e.stopPropagation();
      if (md2) document.execCommand("insertHTML", false, render(md2));
      else if (/https?:\/\//.test(text || "")) document.execCommand("insertHTML", false, linkifyHtml(text));
      else document.execCommand("insertText", false, text || "");
    });
    wrap.querySelector(".md-tb").addEventListener("mousedown", (e) => { if (e.target.closest("button")) e.preventDefault(); }); // keep the selection
    wrap.querySelector(".md-tb").addEventListener("click", (e) => {
      const btn = e.target.closest("button");
      if (!btn) return;
      if (btn.hasAttribute("data-raw")) {
        rawMode = !rawMode;
        if (rawMode) { raw.value = fromHtml(area.innerHTML); raw.hidden = false; area.hidden = true; btn.textContent = "Formatted"; btn.title = "Back to the formatted view"; raw.focus(); }
        else { area.innerHTML = render(raw.value); raw.hidden = true; area.hidden = false; btn.textContent = "Markdown"; btn.title = "Edit the raw Markdown text instead"; area.focus(); }
        wrap.querySelectorAll("[data-cmd]").forEach((x) => { x.disabled = rawMode; });
        return;
      }
      if (rawMode) return;
      area.focus();
      const cmd = btn.getAttribute("data-cmd");
      if (cmd === "code") { const s = String(window.getSelection() || ""); document.execCommand("insertHTML", false, "<code>" + esc(s || "code") + "</code>&nbsp;"); }
      else if (cmd === "box") {
        // A checkbox is a list line: make this line one, then put a box on it.
        const at = () => { const sel = window.getSelection(); const nd = sel && sel.anchorNode; return nd ? (nd.nodeType === 1 ? nd : nd.parentElement).closest("li") : null; };
        let li = at();
        if (!li || !area.contains(li)) { document.execCommand("insertUnorderedList", false, null); li = at(); }
        if (li && area.contains(li)) { li.classList.add("md-task"); fixBoxes(); }
      }
      else document.execCommand(cmd, false, null);
      changed();
    });
    let lastRange = null;
    const keepRange = () => { const sel = window.getSelection(); if (sel && sel.rangeCount && area.contains(sel.getRangeAt(0).startContainer)) lastRange = sel.getRangeAt(0).cloneRange(); };
    area.addEventListener("keyup", keepRange);
    area.addEventListener("mouseup", keepRange);
    area.addEventListener("input", keepRange);
    // Put plain text where the cursor last was (end of the note if it never had one).
    wrap.insertText = (text) => {
      if (rawMode) { raw.focus(); raw.setRangeText(text, raw.selectionStart, raw.selectionEnd, "end"); changed(); return; }
      area.focus();
      const sel = window.getSelection();
      if (lastRange && area.contains(lastRange.startContainer)) { sel.removeAllRanges(); sel.addRange(lastRange); }
      else { const r = document.createRange(); r.selectNodeContents(area); r.collapse(false); sel.removeAllRanges(); sel.addRange(r); }
      const r0 = sel.rangeCount ? sel.getRangeAt(0) : null;
      let before = "";
      if (r0) { try { const pre = document.createRange(); pre.selectNodeContents(area); pre.setEnd(r0.startContainer, r0.startOffset); before = pre.toString().slice(-1); } catch (e) {} }
      const t2 = (before && !/[\s"'(\[]/.test(before) ? " " : "") + text;
      if (/https?:\/\//.test(t2)) document.execCommand("insertHTML", false, linkifyHtml(t2));
      else document.execCommand("insertText", false, t2);
      keepRange();
      changed();
    };
    wrap.getMarkdown = get;
    wrap.focusEnd = () => { const a = rawMode ? raw : area; a.focus(); if (!rawMode) { const r = document.createRange(); r.selectNodeContents(area); r.collapse(false); const s = window.getSelection(); s.removeAllRanges(); s.addRange(r); } };
    wrap.contentEl = () => (rawMode ? raw : area);
    wrap.setMarkdown = (v) => { if (rawMode) raw.value = String(v || ""); else { area.innerHTML = render(v); fixBoxes(); } };
    return wrap;
  }
  const ecss = document.createElement("style");
  ecss.textContent = `
  .md .md-box { cursor: pointer; user-select: none; }
  .md .md-box:hover { color: var(--indigo, #6366f1); }
  .md-ed { border: 1px solid var(--indigo, #6366f1); border-radius: 8px; overflow: hidden; background: var(--card); }
  .md-tb { display: flex; flex-wrap: wrap; gap: 2px; padding: 4px 6px; border-bottom: 1px solid var(--border); background: var(--bg2, rgba(0,0,0,.03)); }
  .md-tb .sp { flex: 1; }
  .md-tb button { font: inherit; font-size: 11.5px; padding: 2px 8px; border: 1px solid transparent; border-radius: 5px; background: none; color: var(--text); cursor: pointer; }
  .md-tb button:hover:not(:disabled) { border-color: var(--border); background: var(--card); }
  .md-tb button:disabled { opacity: .4; cursor: default; }
  .md-tb button[data-cmd="bold"] { font-weight: 800; } .md-tb button[data-cmd="italic"] { font-style: italic; } .md-tb button[data-cmd="strikeThrough"] { text-decoration: line-through; }
  .md-area:empty::before { content: attr(data-ph); color: var(--muted); pointer-events: none; }
  .md-area { min-height: 70px; max-height: 60vh; overflow: auto; padding: 8px 10px; outline: none; font-size: 12.5px; }
  .md-raw { width: 100%; box-sizing: border-box; min-height: 160px; max-height: 60vh; border: 0; padding: 8px 10px; font: 12px ui-monospace, Consolas, monospace; background: var(--card); color: var(--text); resize: vertical; outline: none; }
  `;
  document.head.appendChild(ecss);

  // ---------- every note / comment box writes formatted ----------
  // Plain <textarea>s that pages build themselves (client notes, the task
  // comment box) are swapped for the formatted editor here, so their own code
  // keeps working unchanged: the hidden textarea stays the source of truth -
  // the editor writes Markdown into it (with an input event), setting its value
  // redraws the editor, Ctrl+Enter / Esc and pasted files are handed to it, and
  // focus() goes to the editor.
  const RICH = "textarea.tf-nin, textarea.tf-nein, textarea.tf-rin, textarea.pcm-cmt, textarea.pcm-desc-ta";
  const valueDesc = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value");
  function upgrade(ta) {
    if (ta._mdEd || !ta.isConnected) return;
    const wasFocused = document.activeElement === ta;
    const ed = editor(valueDesc.get.call(ta), { maxLength: Number(ta.maxLength) > 0 ? ta.maxLength : 0, placeholder: ta.placeholder || "",
      onInput: (md) => { valueDesc.set.call(ta, md); ta.dispatchEvent(new Event("input", { bubbles: true })); } });
    ta._mdEd = ed;
    ed.classList.add("md-ed-for");
    ta.style.display = "none";
    ed.hidden = ta.hidden;
    ta.after(ed);
    // A tall box (e.g. the task description) opens just as tall.
    if (Number(ta.rows) > 3) ed.querySelector(".md-area").style.minHeight = Math.min(420, Number(ta.rows) * 20) + "px";
    Object.defineProperty(ta, "value", { configurable: true, get: () => valueDesc.get.call(ta), set: (v) => { valueDesc.set.call(ta, v); ed.setMarkdown(v); } });
    ta.focus = () => ed.focusEnd();
    try { new MutationObserver(() => { ed.hidden = ta.hidden; }).observe(ta, { attributes: true, attributeFilter: ["hidden"] }); } catch (e) {}
    ed.addEventListener("keydown", (e) => {
      if ((e.key === "Enter" && (e.ctrlKey || e.metaKey)) || e.key === "Escape" || ((e.ctrlKey || e.metaKey) && String(e.key).toLowerCase() === "s")) {
        e.preventDefault(); e.stopPropagation();
        ta.dispatchEvent(new KeyboardEvent("keydown", { key: e.key, ctrlKey: e.ctrlKey, metaKey: e.metaKey, bubbles: true, cancelable: true }));
      }
    });
    // Screenshots / files: the editor leaves them alone; hand them to the box's own handler.
    ed.addEventListener("paste", (e) => {
      const fl = [...((e.clipboardData && e.clipboardData.files) || [])];
      if (!fl.length) return;
      e.preventDefault(); e.stopPropagation();
      try { const dt = new DataTransfer(); for (const f of fl) dt.items.add(f); ta.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true })); } catch (err) {}
    });
    ed.addEventListener("dragover", (e) => { if (e.dataTransfer && [...e.dataTransfer.types].includes("Files")) e.preventDefault(); });
    ed.addEventListener("drop", (e) => {
      const fl = [...((e.dataTransfer && e.dataTransfer.files) || [])];
      if (!fl.length) return;
      e.preventDefault(); e.stopPropagation();
      try { const dt = new DataTransfer(); for (const f of fl) dt.items.add(f); ta.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true })); } catch (err) {}
    });
    if (wasFocused) setTimeout(() => ed.focusEnd(), 0);
  }
  const upgradeAll = () => document.querySelectorAll(RICH).forEach(upgrade);
  let upQueued = false;
  new MutationObserver(() => { if (upQueued) return; upQueued = true; queueMicrotask(() => { upQueued = false; upgradeAll(); }); }).observe(document.documentElement, { childList: true, subtree: true });
  upgradeAll();
  const ucss = document.createElement("style");
  ucss.textContent = ".md-ed-for .md-area { min-height: 54px; } .md-ed-for[hidden] { display: none; }" +
    " .pcm-cm-t .md-box { cursor: default; pointer-events: none; }" + // a ClickUp comment's boxes are read-only here
    " .md-area a { cursor: pointer; }";
  document.head.appendChild(ucss);

  window.PcmMd = { render, fromHtml, toggleTask, editor, pasteInto };
})();
