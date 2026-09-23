// Milestone animations. The background can't draw on the screen, so when a
// milestone fires it saves { celebrate: { id, kind, big, mood, at } }: every open
// extension page (popup, side panel, options) plays it at once, and if none was
// open, the next one opened within 30 minutes plays it. Each plays once
// ("celebrateSeen"). mood "happy" = fireworks (target / halfway / almost there),
// mood "sad" = a little rain cloud (the day is falling short). Off via
// settings.celebrations; skipped when the computer asks for reduced motion.
(() => {
  "use strict";
  const FRESH_MS = 30 * 60000;
  const reduced = () => { try { return window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch (e) { return false; } };

  function stage() {
    const cv = document.createElement("canvas");
    cv.setAttribute("aria-hidden", "true");
    cv.style.cssText = "position:fixed;inset:0;width:100vw;height:100vh;pointer-events:none;z-index:2147483000;";
    document.body.appendChild(cv);
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    cv.width = cv.clientWidth * dpr; cv.height = cv.clientHeight * dpr;
    const ctx = cv.getContext("2d");
    ctx.scale(dpr, dpr);
    return { cv, ctx, W: cv.clientWidth, H: cv.clientHeight };
  }

  // ms = how long it lasts (settings.celebrationSeconds, 3 s by default).
  // right = true: keep it to the right part (the small pop-up card, text on the left).
  function fireworks(big, ms = 3000, right = false) {
    if (reduced()) return;
    const { cv, ctx, W, H } = stage();
    const colors = ["#ff5252", "#ffd740", "#69f0ae", "#40c4ff", "#e040fb", "#ff9100", "#ffffff"];
    const rockets = [], sparks = [];
    const launches = big ? Math.max(3, Math.min(9, Math.round(ms / 500))) : 2;
    const span = Math.max(300, ms * 0.45);
    const t0 = performance.now();
    for (let i = 0; i < launches; i++) {
      rockets.push({
        at: t0 + (i / launches) * span + Math.random() * 200,
        x: right ? W * (0.55 + Math.random() * 0.38) : W * (0.15 + Math.random() * 0.7), y: H,
        ty: right ? H * (0.25 + Math.random() * 0.25) : H * (0.15 + Math.random() * 0.35),
        vy: -(H / 55 + Math.random() * 2), done: false,
        color: colors[Math.floor(Math.random() * colors.length)],
      });
    }
    const burst = (r) => {
      const n = big ? 70 : 45;
      for (let i = 0; i < n; i++) {
        const a = (Math.PI * 2 * i) / n + Math.random() * 0.2;
        const sp = (1.5 + Math.random() * (big ? 3.8 : 3)) * (right ? 0.45 : 1);
        sparks.push({ x: r.x, y: r.y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 1, color: Math.random() < 0.7 ? r.color : colors[Math.floor(Math.random() * colors.length)] });
      }
    };
    const frame = (now) => {
      ctx.clearRect(0, 0, W, H);
      for (const r of rockets) {
        if (r.done || now < r.at) continue;
        r.y += r.vy; r.vy *= 0.985;
        ctx.fillStyle = r.color;
        ctx.beginPath(); ctx.arc(r.x, r.y, 2.2, 0, Math.PI * 2); ctx.fill();
        if (r.y <= r.ty || r.vy > -1) { r.done = true; burst(r); }
      }
      for (const s of sparks) {
        if (s.life <= 0) continue;
        s.x += s.vx; s.y += s.vy; s.vy += 0.05; s.vx *= 0.985; s.vy *= 0.985; s.life -= 0.012;
        ctx.globalAlpha = Math.max(0, s.life);
        ctx.fillStyle = s.color;
        ctx.beginPath(); ctx.arc(s.x, s.y, 2, 0, Math.PI * 2); ctx.fill();
      }
      ctx.globalAlpha = 1;
      const busy = rockets.some((r) => !r.done) || sparks.some((s) => s.life > 0);
      if (busy && now - t0 < ms) requestAnimationFrame(frame);
      else cv.remove();
    };
    requestAnimationFrame(frame);
  }

  // A small grey cloud drifts in, frowns, rains for a few seconds, then fades.
  function rainCloud(big, ms = 3000, right = false) {
    if (reduced()) return;
    const { cv, ctx, W, H } = stage();
    const dur = Math.max(1500, ms);
    const s = right ? Math.min(0.45, H / 170) : Math.min(1.25, Math.max(0.6, W / 520)) * (big ? 1 : 0.8);
    const cy = right ? Math.max(30 * s + 4, H * 0.32) : Math.min(H * 0.3, 150);
    const drops = [];
    const t0 = performance.now();
    const blob = (x, y, r) => { ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill(); };
    const cloud = (cx, alpha) => {
      ctx.globalAlpha = alpha;
      ctx.fillStyle = "#9aa3b5";
      for (const [dx, dy, r] of [[-60, 10, 40], [-18, -14, 52], [38, -2, 45], [80, 14, 34], [-92, 22, 28], [8, 22, 44]]) blob(cx + dx * s, cy + dy * s + 5, r * s);
      ctx.fillStyle = "#bcc4d4";
      for (const [dx, dy, r] of [[-60, 10, 40], [-18, -14, 52], [38, -2, 45], [80, 14, 34], [-92, 22, 28], [8, 22, 44]]) blob(cx + dx * s, cy + dy * s, r * s);
      ctx.fillStyle = "#4a5268";
      blob(cx - 22 * s, cy - 6 * s, 5 * s);
      blob(cx + 22 * s, cy - 6 * s, 5 * s);
      ctx.strokeStyle = "#4a5268"; ctx.lineWidth = 3.5 * s; ctx.lineCap = "round";
      ctx.beginPath(); ctx.arc(cx, cy + 22 * s, 16 * s, 1.15 * Math.PI, 1.85 * Math.PI); ctx.stroke();
      ctx.globalAlpha = 1;
    };
    const frame = (now) => {
      const t = now - t0;
      ctx.clearRect(0, 0, W, H);
      const inT = Math.min(1, t / 500);
      const outT = Math.max(0, (t - (dur - 700)) / 700);
      const alpha = Math.max(0, Math.min(inT, 1 - outT));
      const home = right ? W * 0.76 : W / 2;
      const cx = home + (1 - inT) * -W * (right ? 0.1 : 0.25);
      if (t > 400 && t < dur - 500) {
        for (let i = 0; i < (big ? 4 : 2); i++) drops.push({ x: cx + (Math.random() - 0.5) * 170 * s, y: cy + 30 * s, v: 4 + Math.random() * 3 });
      }
      ctx.strokeStyle = "#78aaeb"; ctx.lineWidth = 2;
      for (const d of drops) {
        d.y += d.v;
        if (d.y > H) continue;
        ctx.globalAlpha = alpha * 0.85;
        ctx.beginPath(); ctx.moveTo(d.x, d.y); ctx.lineTo(d.x - 2, d.y + 10); ctx.stroke();
      }
      cloud(cx, alpha);
      if (t < dur) requestAnimationFrame(frame);
      else cv.remove();
    };
    requestAnimationFrame(frame);
  }

  const lengthMs = (c) => Math.max(1, Math.min(15, Number(c && c.secs) || 3)) * 1000;
  const play = (c) => (c && c.mood === "sad" ? rainCloud(!!c.big, lengthMs(c), !!c.right) : fireworks(!!(c && c.big), lengthMs(c), !!(c && c.right)));

  let playing = "";
  async function maybePlay(c) {
    if (!c || !c.id || playing === c.id || Date.now() - (Number(c.at) || 0) > FRESH_MS) return;
    if (document.visibilityState !== "visible") return;
    let got = {};
    try { got = await chrome.storage.local.get(["settings", "celebrateSeen"]); } catch (e) {}
    if (got.settings && got.settings.celebrations === false && !c.preview) return;
    if (c.preview && !c._live) return; // a preview only plays for pages open at the time
    playing = c.id;
    // A page that's open when it fires always plays; a page opened later plays
    // it only if nobody has seen it yet.
    if (!c._live && got.celebrateSeen === c.id) return;
    try { await chrome.storage.local.set({ celebrateSeen: c.id }); } catch (e) {}
    play(c);
  }
  // The pop-up fireworks window (celebrate.html) plays what it's told instead.
  if (!document.documentElement.hasAttribute("data-no-auto-celebrate")) {
    try {
      chrome.storage.local.get("celebrate").then((g) => maybePlay(g && g.celebrate)).catch(() => {});
      chrome.storage.onChanged.addListener((ch, area) => {
        if (area === "local" && ch.celebrate && ch.celebrate.newValue) maybePlay({ ...ch.celebrate.newValue, _live: true });
      });
      // Fired while this tab was in the background: play when it's looked at again.
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") chrome.storage.local.get("celebrate").then((g) => maybePlay(g && g.celebrate)).catch(() => {});
      });
    } catch (e) {}
  }
  window.pcmFireworks = fireworks;
  window.pcmRainCloud = rainCloud;
  window.pcmCelebrate = play;
})();
