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

  const css = document.createElement("style");
  css.textContent = `
    /* the switch */
    .pcm-simple-btn.on { color: var(--indigo, #6366f1) !important; border-color: var(--indigo, #6366f1) !important; background: rgba(99,102,241,.12) !important; }
    .pcm-simple-btn { --ico: url("data:image/svg+xml,${encodeURIComponent("<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2.2' stroke-linecap='round'><path d='M4 7h16M4 12h11M4 17h6'/></svg>")}"); }

    /* ---- what Simple view puts away ---- */
    /* explanation text under titles and settings */
    html.pcm-simple .pcm-expl, html.pcm-simple p.sub, html.pcm-simple .lt-sub, html.pcm-simple .wk-hint { display: none !important; }
    /* status chips under the page title, the "Worth a look" strip, the setup card */
    html.pcm-simple #statusStrip, html.pcm-simple #pcmDashStrip, html.pcm-simple .pcm-setup, html.pcm-simple #deskTry { display: none !important; }
    /* Due today card: the Custom / Meeting choice, its note box, Add missed time */
    html.pcm-simple #cuXMode, html.pcm-simple .amt-link, html.pcm-simple #cuAutoExtra .cu-autox-h .hint { display: none !important; }
    /* This week card: the multi-day choice */
    html.pcm-simple #optWeekMode { display: none !important; }
    /* Tasks card: the summary line ("Shown: 14 tasks ...") and the plan-a-task line */
    html.pcm-simple .cu-totals, html.pcm-simple #ltBox .lt-head .lt-sub { display: none !important; }
    /* Recently completed and Explore tasks cards (Ctrl+K finds any task) */
    html.pcm-simple #dashDoneCard, html.pcm-simple #dashExploreCard { display: none !important; }
    /* task rows: pin / note marks (a pinned task keeps its pin), parent prefix, guesses, "in all" */
    html.pcm-simple .cu-task .tn-marks .tn-b:not([aria-pressed="true"]):not(.tn-cmt), html.pcm-simple .cu-task .cu-parent,
    html.pcm-simple .cu-task .est-guess, html.pcm-simple .cu-task .trk-all, html.pcm-simple .cu-task .cu-kids { display: none !important; }
    /* popup / side panel: the setup line, the small grey summaries, the switch hint, Drive sync's explanation */
    html.pcm-simple .pcm-setupline, html.pcm-simple #cuSub, html.pcm-simple #weekSub, html.pcm-simple .cu-timer-hint, html.pcm-simple #syncHelp { display: none !important; }
    /* settings pages: the "More" / advanced blocks stay folded and quiet */
    html.pcm-simple details.adv:not([open]) > summary { opacity: .7; }
  `;
  document.head.appendChild(css);

  const btns = new Set();
  function paint() {
    root.classList.toggle("pcm-simple", on);
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
  let mt = 0;
  new MutationObserver(() => { if (!mt) mt = setTimeout(() => { mt = 0; mark(); }, 300); }).observe(document.body, { childList: true, subtree: true });

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
    paint();
  }
  addButton();
  addSetting();
  // The header can be redrawn (header-ui.js dresses the buttons after load).
  setTimeout(() => { addButton(); addSetting(); }, 600);
  window.PcmSimple = { set, get: () => on };
})();
