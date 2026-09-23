// Visual effects shared by the popup, side panel and options page. Each one can
// be switched off in Options > General > Animations and effects (settings
// fxLiquid / fxChart / fxCount; the toolbar ring fxIconRing lives in the
// background). Off automatically when the computer asks for reduced motion.
// Kept light: the moving parts are transform/opacity animations the browser
// runs on the GPU, and hidden pages don't animate at all.
(() => {
  "use strict";
  const css = `
  /* ---- flowing progress bars: one soft light band travels along the fill ---- */
  html.fx-liquid .cu-fill, html.fx-liquid .cu-fill2 { position: relative; overflow: hidden; transition: width .9s cubic-bezier(.22,1,.36,1); }
  html.fx-liquid .cu-fill::after, html.fx-liquid .cu-fill2::after { content: ""; position: absolute; top: 0; bottom: 0; left: 0; width: 45%;
    background: linear-gradient(90deg, rgba(255,255,255,0), rgba(255,255,255,.38), rgba(255,255,255,0));
    transform: translateX(-100%); animation: pcm-flow 2.8s ease-in-out infinite; will-change: transform; }
  html.fx-liquid .cu-fill.met::after, html.fx-liquid .cu-fill2.met::after { animation-duration: 1.8s; }
  /* Dark mode's bar colours are light, so the band needs to be brighter to show. */
  html.fx-liquid[data-theme="dark"] .cu-fill::after, html.fx-liquid[data-theme="dark"] .cu-fill2::after { width: 38%;
    background: linear-gradient(90deg, rgba(255,255,255,0), rgba(255,255,255,.55) 35%, rgba(255,255,255,.85) 50%, rgba(255,255,255,.55) 65%, rgba(255,255,255,0)); }
  @keyframes pcm-flow { 0% { transform: translateX(-100%); } 70%, 100% { transform: translateX(230%); } }
  /* ---- week chart ---- */
  .wk-day { position: relative; }
  .wk-tip { position: absolute; bottom: calc(100% - 6px); left: 50%; transform: translate(-50%, 4px); z-index: 5; pointer-events: none; opacity: 0;
    min-width: 120px; padding: 6px 9px; border-radius: 8px; background: var(--card); border: 1px solid var(--border); box-shadow: 0 8px 20px rgba(0,0,0,.18);
    font-size: 11px; line-height: 1.5; color: var(--text); white-space: nowrap; text-align: left; }
  .wk-tip b { display: block; font-size: 11.5px; margin-bottom: 2px; }
  .wk-tip i { display: inline-block; width: 8px; height: 8px; border-radius: 2px; margin-right: 5px; vertical-align: 0; }
  .wk-day:hover .wk-tip { opacity: 1; transform: translate(-50%, 0); }
  html.fx-chart .wk-tip { transition: opacity .18s, transform .18s; }
  html.fx-chart .wk-bar { transform-origin: bottom; animation: pcm-grow .7s cubic-bezier(.22,1,.36,1) both; transition: transform .2s, filter .2s; }
  html.fx-chart .wk-day { transition: opacity .2s; cursor: default; }
  html.fx-chart .wk-chart:hover .wk-day:not(:hover):not(.wk-legend) { opacity: .5; }
  html.fx-chart .wk-day:hover .wk-bar { transform: scaleY(1.06); filter: brightness(1.18) saturate(1.1); }
  @keyframes pcm-grow { from { transform: scaleY(0); } to { transform: scaleY(1); } }
  @media (prefers-reduced-motion: reduce) {
    html.fx-liquid .cu-fill::after, html.fx-liquid .cu-fill2::after,
    html.fx-chart .wk-bar { animation: none !important; }
  }`;
  const style = document.createElement("style");
  style.textContent = css;
  (document.head || document.documentElement).appendChild(style);

  const reduced = () => { try { return window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch (e) { return false; } };
  let on = { liquid: true, chart: true, count: true };
  function apply(settings) {
    const st = settings || {};
    on = { liquid: st.fxLiquid !== false, chart: st.fxChart !== false, count: st.fxCount !== false };
    const h = document.documentElement.classList;
    h.toggle("fx-liquid", on.liquid);
    h.toggle("fx-chart", on.chart);
  }
  try {
    chrome.storage.local.get("settings").then((g) => apply(g && g.settings)).catch(() => apply({}));
    chrome.storage.onChanged.addListener((ch, area) => { if (area === "local" && ch.settings) apply(ch.settings.newValue); });
  } catch (e) { apply({}); }
  apply({}); // on by default until the stored settings arrive

  // Count a duration up to its new value (e.g. the big "7h 24m"). `node` is an
  // element or a text node; `key` remembers the last value per number, so it
  // counts from where it was (from 0 on the first show).
  const last = {};
  window.pcmCountTo = function countTo(node, key, toMs, fmt) {
    const to = Math.max(0, Number(toMs) || 0);
    const from = key in last ? last[key] : 0;
    last[key] = to;
    const set = (v) => { node.textContent = fmt(v) + (node.nodeType === 3 && /\s$/.test(node.textContent) ? " " : ""); };
    if (!on.count || reduced() || document.visibilityState !== "visible" || Math.abs(to - from) < 60000) { set(to); return; }
    const t0 = performance.now(), dur = 700;
    const step = (now) => {
      const k = Math.min(1, (now - t0) / dur);
      const e = 1 - Math.pow(1 - k, 3);
      set(Math.round((from + (to - from) * e) / 60000) * 60000);
      if (k < 1 && last[key] === to) requestAnimationFrame(step);
      else if (last[key] === to) set(to);
    };
    set(from);
    requestAnimationFrame(step);
    // If the page stops painting mid-way, still land on the right number.
    setTimeout(() => { if (last[key] === to) set(to); }, dur + 300);
  };
})();
