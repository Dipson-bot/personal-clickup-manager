// Simple view: the same extension with the extras out of sight - explanation
// text, status lines and summaries, secondary controls, and the AI and time
// sections of a task's details. Nothing is turned off; switching back shows it
// all again. Off by default. One switch in the page header (dashboard, popup and
// side panel) and one in General > Appearance; remembered for every page.
(() => {
  "use strict";
  const root = document.documentElement;
  const KEY = "uiSimple";
  // Applied at once from this page's own copy (no flash of the full view), then
  // kept in step with the stored setting (Drive backup, the other pages).
  let on = false;
  try { on = localStorage.getItem("pcmSimple") === "1"; } catch (e) {}
  root.classList.toggle("pcm-simple", on);
  // Short help text (the full view): a long explanation shows as its first line
  // and a "… more" button. On unless switched off in General > Appearance.
  const FKEY = "uiHelpFold";
  let foldOn = true;
  try { foldOn = localStorage.getItem("pcmHelpFold") !== "0"; } catch (e) {}
  root.classList.toggle("pcm-helpfold", foldOn);

  const css = document.createElement("style");
  css.textContent = `
    /* the switch */
    .pcm-simple-btn.on { color: var(--indigo, #6366f1) !important; border-color: var(--indigo, #6366f1) !important; background: rgba(99,102,241,.12) !important; }
    .pcm-simple-btn { --ico: url("data:image/svg+xml,${encodeURIComponent("<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2.2' stroke-linecap='round'><path d='M4 7h16M4 12h11M4 17h6'/></svg>")}"); }

    /* ---- what Simple view puts away ---- */
    /* explanation text under titles and settings */
    html.pcm-simple .pcm-expl, html.pcm-simple p.sub, html.pcm-simple .lt-sub, html.pcm-simple .wk-hint, html.pcm-simple .ip-sub { display: none !important; }
    /* status chips under the page title, the "Worth a look" strip, the setup card */
    html.pcm-simple #statusStrip, html.pcm-simple #pcmDashStrip, html.pcm-simple .pcm-setup, html.pcm-simple #deskTry { display: none !important; }
    /* Due today card: the Custom / Meeting choice, its note box, Add missed time */
    /* (Custom / Meeting, its note and Add missed time stay: they are things you DO, not text to read) */
    html.pcm-simple #cuAutoExtra .cu-autox-h .hint { display: none !important; }
    /* This week card: the multi-day choice */
    html.pcm-simple #optWeekMode { display: none !important; }
    /* Tasks card: the summary line ("Shown: 14 tasks ...") and the plan-a-task line */
    html.pcm-simple .cu-totals, html.pcm-simple #ltBox .lt-head .lt-sub { display: none !important; }
    /* Recently completed (Ctrl+K finds any task). Explore tasks stays: it is a tool (anyone's tasks, by date / client) */
    html.pcm-simple #dashDoneCard { display: none !important; }
    /* task rows: parent prefix, "in all" (the ~guesses, 📌 / 📝 / ✓ stay: they are what you plan and act with) */
    html.pcm-simple .cu-task .cu-parent,
    html.pcm-simple .cu-task .trk-all, html.pcm-simple .cu-task .cu-kids { display: none !important; }
    /* popup / side panel: the setup line, the small grey summaries, the switch hint, Drive sync's explanation */
    html.pcm-simple .pcm-setupline, html.pcm-simple #cuSub, html.pcm-simple #weekSub, html.pcm-simple .cu-timer-hint, html.pcm-simple #syncHelp { display: none !important; }
    /* Dashboard: the Extra task controls (Today card) and the daily chart (This
       week card) fold away with Show / Hide - see "Show / Hide" below */
    #cuTodayWrap, #dashWeekCard { display: flex; flex-direction: column; }
    #cuTodayWrap > #cuAutoExtra, #dashWeekCard > .pcm-foldrow { margin-top: auto; padding-top: 10px; border-top: 1px dashed var(--border, #e4e4e7); }
    #dashWeekCard > .pcm-foldrow { display: flex; align-items: baseline; gap: 6px; margin-top: auto; font-size: 12.5px; }
    #dashWeekCard > .pcm-foldrow b { font-weight: 600; }
    .pcm-foldbtn { margin-left: auto; flex: none; font: inherit; font-size: 11.5px; font-weight: 600; padding: 2px 10px; border-radius: 999px; border: 1px solid var(--border, #d4d4d8); background: transparent; color: var(--indigo, #6366f1); cursor: pointer; }
    .pcm-foldbtn:hover { background: rgba(99,102,241,.1); }
    #cuAutoExtra.pcm-folded > :not(.cu-autox-h) { display: none !important; }
    #dashWeekCard.pcm-folded #optWeekSub, #dashWeekCard.pcm-folded #optWeekMode, #dashWeekCard.pcm-folded #optWeekChart { display: none !important; }
    #dashWeekCard:not(.pcm-folded) > .pcm-foldrow + #optWeekSub { margin-top: 4px; }
    /* Short help text: one line + "… more" (only when it really runs longer).
       max-height, not display, so anything a page hides stays hidden. */
    html.pcm-helpfold .pcm-fold:not(.pcm-open):not(.pcm-fit) { max-height: calc(1lh + 1px); overflow: hidden; position: relative; padding-right: 4.6em; }
    html.pcm-helpfold .pcm-fold.pcm-open { position: relative; }
    .pcm-morebtn { display: none; }
    html.pcm-helpfold .pcm-fold:not(.pcm-fit) > .pcm-morebtn { display: inline-block; }
    html.pcm-helpfold .pcm-fold:not(.pcm-open):not(.pcm-fit) > .pcm-morebtn { position: absolute; right: 0; top: 0; }
    .pcm-morebtn { font: inherit; font-size: 11px; font-weight: 600; line-height: 1.5; padding: 0 6px; margin-left: 6px; border: 0; border-radius: 999px; background: rgba(99,102,241,.1); color: var(--indigo, #6366f1); cursor: pointer; vertical-align: baseline; white-space: nowrap; }
    /* an explanation after a setting's name ("Moving weather - the snow...") */
    html.pcm-helpfold .pcm-ifold:not(.pcm-open) { display: none; }
    html.pcm-helpfold:not(.pcm-simple) .pcm-ifold + .pcm-morebtn { display: inline-block; }
    .pcm-ifold.pcm-open + .pcm-morebtn::before { content: "less" !important; }
    .pcm-morebtn:hover { background: rgba(99,102,241,.2); }
    .pcm-morebtn::before { content: "… more"; }
    .pcm-fold.pcm-open > .pcm-morebtn::before { content: "less"; }
    /* settings pages: the "More" / advanced blocks stay folded and quiet */
    html.pcm-simple details.adv:not([open]) > summary { opacity: .7; }
  `;
  document.head.appendChild(css);

  // ---- Show / Hide: the Extra task controls and the daily chart (dashboard) ----
  // Simple view starts with them hidden, the full view with them shown; a Show
  // or Hide is remembered for that view (storage dashFold { simple, full }).
  const FOLD_KEY = "dashFold";
  let fold = {};
  const FOLDS = [
    { k: "extra", host: "cuAutoExtra", what: "the Extra task's Start tracking, Meeting and Add missed time" },
    { k: "chart", host: "dashWeekCard", what: "the day-by-day chart" },
  ];
  const folded = (k) => { const m = fold[on ? "simple" : "full"] || {}; return typeof m[k] === "boolean" ? m[k] : on; };
  async function setFold(k, v) {
    const view = on ? "simple" : "full";
    fold = { ...fold, [view]: { ...(fold[view] || {}), [k]: v } };
    paintFolds();
    try { await chrome.storage.local.set({ [FOLD_KEY]: fold }); } catch (e) {}
  }
  function paintFolds() {
    for (const f of FOLDS) {
      const host = document.getElementById(f.host);
      if (!host) continue;
      let b = host.querySelector(".pcm-foldbtn");
      if (!b) {
        b = document.createElement("button");
        b.type = "button";
        b.className = "pcm-foldbtn";
        b.onclick = (e) => { e.stopPropagation(); setFold(f.k, !folded(f.k)); };
        if (f.k === "extra") { const h = host.querySelector(".cu-autox-h"); if (!h) continue; h.appendChild(b); }
        else {
          const sub = document.getElementById("optWeekSub");
          if (!sub) continue;
          const row = document.createElement("div");
          row.className = "pcm-foldrow";
          const lab = document.createElement("b");
          lab.textContent = "Daily chart";
          row.append(lab, b);
          sub.before(row);
        }
      }
      const hid = folded(f.k);
      host.classList.toggle("pcm-folded", hid);
      b.textContent = hid ? "▸ Show" : "▾ Hide";
      b.title = (hid ? "Show " : "Hide ") + f.what + " (remembered for " + (on ? "Simple view" : "the full view") + ")";
      b.setAttribute("aria-expanded", String(!hid));
    }
  }
  chrome.storage.local.get(FOLD_KEY).then((g) => { fold = (g && g[FOLD_KEY] && typeof g[FOLD_KEY] === "object") ? g[FOLD_KEY] : {}; paintFolds(); }).catch(() => {});
  chrome.storage.onChanged.addListener((ch, area) => { if (area === "local" && ch[FOLD_KEY]) { fold = ch[FOLD_KEY].newValue || {}; paintFolds(); } });

  const btns = new Set();
  function paint() {
    root.classList.toggle("pcm-simple", on);
    paintFolds();
    for (const b of btns) {
      b.classList.toggle("on", on);
      b.title = on ? "Simple view is on - click for the full view" : "Simple view: hide the extra text and controls";
      b.setAttribute("aria-pressed", String(on));
    }
    const cb = document.getElementById("simpleViewOn");
    if (cb) cb.checked = on;
  }
  async function set(v) {
    on = !!v;
    try { localStorage.setItem("pcmSimple", on ? "1" : "0"); } catch (e) {}
    paint();
    try { await chrome.storage.local.set({ [KEY]: on }); } catch (e) {}
  }
  chrome.storage.local.get(KEY).then((g) => {
    if (g && typeof g[KEY] === "boolean" && g[KEY] !== on) { on = g[KEY]; try { localStorage.setItem("pcmSimple", on ? "1" : "0"); } catch (e) {} }
    paint();
  }).catch(() => {});
  chrome.storage.onChanged.addListener((ch, area) => {
    if (area !== "local" || !ch[KEY]) return;
    on = !!ch[KEY].newValue;
    try { localStorage.setItem("pcmSimple", on ? "1" : "0"); } catch (e) {}
    paint();
  });

  // Which grey text is an explanation (put away) and which is information (kept):
  // a hint of some length that is not inside a list row or a status / message
  // line. Site statuses, task rows, reminders, saved / error messages stay.
  const KEEP = ".imp-row, .imp-entry, .cu-task, .hb-row, .rm-item, li, .msg, .au-st, .pcm-panel, [id$=\"Status\"], [id$=\"Msg\"], [id$=\"Saved\"], [id$=\"Note\"], [role=status], [aria-live]";
  function mark() {
    for (const h of document.querySelectorAll(".hint:not([data-pse])")) {
      h.dataset.pse = "1";
      const t = (h.textContent || "").trim();
      if (t.length >= 55 && !h.closest(KEEP) && !(h.id && /(Status|Msg|Saved|Note|Info|Result)$/i.test(h.id))) h.classList.add("pcm-expl");
    }
  }
  mark();

  // ---- Short help text (the full view) ----
  // The explanations Simple view puts away, and long checkbox / setting
  // descriptions, show their first line and a "… more" button. Nothing with a
  // control, a list or a status inside is folded, and text that fits on one
  // line at this width is left alone.
  const FOLD_OF = ".pcm-expl, label > span.hint, .checkbox span.hint, .set-line > label, .set-line > .grow";
  const NO_FOLD_IN = "input, select, textarea, button:not(.pcm-morebtn), ul, ol, table, details, img, canvas, iframe, p, div, pre";
  const folds = new Set();
  const ro = typeof ResizeObserver === "function" ? new ResizeObserver((es) => { for (const e of es) fit(e.target); }) : null;
  function fit(el) {
    if (!el.isConnected) { folds.delete(el); if (ro) ro.unobserve(el); return; }
    if (el.classList.contains("pcm-open")) return;
    if (!foldOn) return; // measured again when it is switched back on
    if (!el.offsetWidth) return; // not on screen yet: measured when it shows
    el.classList.remove("pcm-fit");
    el.classList.toggle("pcm-fit", el.scrollHeight <= el.clientHeight + 2);
  }
  function foldable(el) {
    if (el.dataset.pcf) return false;
    el.dataset.pcf = "1";
    const t = (el.textContent || "").trim();
    const min = el.matches(".set-line > label, .set-line > .grow") ? 110 : 55;
    if (t.length < min || el.closest(KEEP) || el.querySelector(NO_FOLD_IN)) return false;
    if (el.id && /(Status|Msg|Saved|Note|Info|Result|Line|State|Err|Out)$/i.test(el.id)) return false;
    if (/^inline/.test(getComputedStyle(el).display)) {
      // inline: only an explanation after a setting's own name, inside its label
      const host = el.parentElement;
      if (!host || !host.matches("label, .checkbox, .set-line")) return false;
      const rest = (host.textContent || "").replace(t, "").trim();
      return rest.length >= 3 ? "inline" : false;
    }
    return true;
  }
  function addFolds() {
    for (const el of document.querySelectorAll(FOLD_OF)) {
      const kind = foldable(el);
      if (!kind) continue;
      if (kind === "inline") {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "pcm-morebtn";
        b.setAttribute("aria-label", "Show what this setting does");
        b.onclick = (e) => { e.preventDefault(); e.stopPropagation(); el.classList.toggle("pcm-open"); };
        el.classList.add("pcm-ifold");
        el.after(b);
        continue;
      }
      const b = document.createElement("button");
      b.type = "button";
      b.className = "pcm-morebtn";
      b.setAttribute("aria-label", "Show all of this text");
      b.onclick = (e) => {
        e.preventDefault(); e.stopPropagation();
        const open = el.classList.toggle("pcm-open");
        b.setAttribute("aria-label", open ? "Show less" : "Show all of this text");
        if (!open) fit(el);
      };
      el.appendChild(b);
      el.classList.add("pcm-fold");
      folds.add(el);
      if (ro) ro.observe(el);
      fit(el);
    }
  }
  addFolds();
  // A page that rewrites a folded text: measured again.
  let fq = false;
  function refit() { if (fq) return; fq = true; requestAnimationFrame(() => { fq = false; for (const el of folds) fit(el); }); }
  function setFoldOn(v) {
    foldOn = v !== false;
    root.classList.toggle("pcm-helpfold", foldOn);
    try { localStorage.setItem("pcmHelpFold", foldOn ? "1" : "0"); } catch (e) {}
    const cb = document.getElementById("helpFoldOn");
    if (cb) cb.checked = foldOn;
    refit();
  }
  chrome.storage.local.get(FKEY).then((g) => { if (g && typeof g[FKEY] === "boolean") setFoldOn(g[FKEY]); }).catch(() => {});
  chrome.storage.onChanged.addListener((ch, area) => { if (area === "local" && ch[FKEY]) setFoldOn(ch[FKEY].newValue); });
  // Sorted in the same moment the text is drawn, before the browser paints: on a
  // 300 ms timer every new explanation showed for a moment and was then hidden,
  // so the page jumped (Insights > Plan / Performance on every tab switch).
  let mq = false;
  new MutationObserver((recs) => {
    for (const r of recs) { const f = r.target && r.target.closest && r.target.closest(".pcm-fold"); if (f && !(r.addedNodes.length === 1 && r.addedNodes[0].className === "pcm-morebtn")) { f.classList.remove("pcm-open"); if (!f.querySelector(":scope > .pcm-morebtn")) delete f.dataset.pcf, f.classList.remove("pcm-fold"); refit(); } }
    if (mq) return; mq = true; queueMicrotask(() => { mq = false; mark(); addFolds(); });
  }).observe(document.body, { childList: true, subtree: true });

  // The header switch: next to light / dark.
  function addButton() {
    const theme = document.getElementById("themeToggle");
    if (!theme || document.getElementById("simpleViewBtn")) return;
    const b = document.createElement("button");
    b.type = "button";
    b.id = "simpleViewBtn";
    b.className = theme.className.replace(/\bpcm-ib\b/, "").trim() + " pcm-ib pcm-simple-btn";
    b.setAttribute("aria-label", "Simple view");
    b.onclick = (e) => { e.stopPropagation(); set(!on); };
    theme.before(b);
    btns.add(b);
    paint();
  }
  // General > Appearance: the same switch, with what it does.
  function addSetting() {
    const card = document.getElementById("appearanceCard");
    if (!card || document.getElementById("simpleViewOn")) return;
    const line = document.createElement("label");
    line.className = "set-line";
    line.style.cssText = "display:flex;align-items:center;gap:10px;margin:0 0 12px;cursor:pointer;";
    line.innerHTML = '<input type="checkbox" id="simpleViewOn" /><span class="grow"><b>Simple view</b> - hide the explanation text, summaries and extra controls, and show only Details, Comments and My notes in a task\'s details. Nothing is switched off: turn this off to see everything again. Also the <b>≡</b> button at the top of every page.</span>';
    const h2 = card.querySelector("h2");
    if (h2) h2.after(line); else card.prepend(line);
    line.querySelector("input").addEventListener("change", (e) => set(e.target.checked));
    const hl = document.createElement("label");
    hl.className = "set-line";
    hl.style.cssText = line.style.cssText;
    hl.innerHTML = '<input type="checkbox" id="helpFoldOn" /><span class="grow"><b>Short help text</b> - long explanations show one line and a <b>… more</b> button; off shows them in full.</span>';
    line.after(hl);
    const hc = hl.querySelector("input");
    hc.checked = foldOn;
    hc.addEventListener("change", async (e) => { setFoldOn(e.target.checked); try { await chrome.storage.local.set({ [FKEY]: e.target.checked }); } catch (x) {} });
    paint();
  }
  addButton();
  addSetting();
  // The header can be redrawn (header-ui.js dresses the buttons after load).
  setTimeout(() => { addButton(); addSetting(); }, 600);
  window.PcmSimple = { set, get: () => on, setHelpFold: setFoldOn };
})();
