// The look: Studio, for everyone (the Classic look was retired on 2026-11-27, once
// Studio covered every tab). Set in <head> before the page paints; theme-studio.css
// and studio.js read html[data-ui="studio"]. Palettes, light / dark and wallpapers
// still work on top of it (◐ menu).
(() => {
  document.documentElement.dataset.ui = "studio";
  window.PcmUi = { get: () => "studio", set: () => Promise.resolve() };
})();
// Back to top / Go to bottom: two round buttons on every extension page and every tab
// (dashboard, popup, side panel, wrap up). Whatever is scrolling - the page or a big
// scrolling panel - is watched: ↑ shows once you are well down it, ↓ while a lot is
// still below. Checked on scroll, resize, tab switches and when content grows, so a
// long page shows ↓ before anyone has scrolled.
(() => {
  if (typeof document === "undefined" || typeof document.addEventListener !== "function") return;
  const docEl = () => document.scrollingElement || document.documentElement;
  let area = null, box = null, up = null, down = null, raf = 0;
  const btn = (cls, label, txt, go) => {
    const b = document.createElement("button");
    b.type = "button"; b.className = "pcm-totop " + cls; b.title = label; b.setAttribute("aria-label", label); b.textContent = txt;
    b.onclick = () => { const el = live(); el.scrollTo({ top: go(el), behavior: "smooth" }); };
    return b;
  };
  const make = () => {
    if (box || !document.body) return;
    box = document.createElement("div");
    box.className = "pcm-scrollbtns";
    up = btn("up", "Back to top", "↑", () => 0);
    down = btn("down", "Go to the bottom", "↓", (el) => el.scrollHeight);
    box.append(up, down);
    document.body.appendChild(box);
  };
  // The area being read: the last big area scrolled, if it is still on screen and still scrolls; else the page.
  const live = () => (area && area.isConnected && area.scrollHeight > area.clientHeight + 40 && area.getClientRects().length ? area : docEl());
  const check = () => {
    raf = 0;
    const el = live(), h = el === docEl() ? window.innerHeight : el.clientHeight;
    const long = el.scrollHeight > h * 2.2, below = el.scrollHeight - el.scrollTop - h;
    const showUp = el.scrollTop > Math.max(500, h * 1.2), showDown = long && below > Math.max(600, h * 1.2);
    if (showUp || showDown) make();
    if (!box) return;
    up.classList.toggle("on", showUp);
    down.classList.toggle("on", showDown);
  };
  const soon = () => { if (!raf) raf = requestAnimationFrame(check); };
  document.addEventListener("scroll", (e) => {
    const t = e.target && e.target.nodeType === 9 ? docEl() : e.target;
    // Only big scrolling areas count (not a menu, a small list or a textarea); dialogs have their own.
    if (!t || (t !== docEl() && (t.clientHeight < 300 || t.tagName === "TEXTAREA" || (t.closest && t.closest(".sd-back, .lt-modal, .sm-gd-m"))))) return;
    area = t === document.documentElement || t === document.body ? docEl() : t;
    soon();
  }, { capture: true, passive: true });
  window.addEventListener("resize", soon, { passive: true });
  window.addEventListener("hashchange", () => { area = null; setTimeout(soon, 250); });
  document.addEventListener("click", () => setTimeout(soon, 300), true); // a tab or section opened
  const start = () => {
    soon();
    // Content that grows (lists loading, a tab filling in): re-checked, at most every 0.5s.
    let t = 0;
    try { new MutationObserver(() => { if (!t) t = setTimeout(() => { t = 0; soon(); }, 500); }).observe(document.body, { childList: true, subtree: true }); } catch (e) {}
  };
  if (document.body) start(); else document.addEventListener("DOMContentLoaded", start);
})();
