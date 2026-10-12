// Task weather background: the running task's timer as the weather. It starts
// with snow, clears up and the sun comes out as the tracked time nears the
// estimate, is perfect on the estimate, then clouds over, rains, storms and at
// last the mountain erupts as the task runs further past it. No timer: calm
// skies. Shared by the popup, side panel and options page; switched on by
// header-ui.js (Background: Task weather / Plain / Wallpaper - themeScene). Not
// the default (it animates, so it uses a little more of the computer): chosen in
// the ☀ menu or General › Appearance. How see-through the cards are is its own
// setting there (themeCards, header-ui.js), shared with wallpapers.
// Light on the computer: one canvas, ~30 frames a second, a capped number of
// particles, nothing while the page is hidden, a still picture when Windows
// asks for reduced motion or "Moving weather" is off (settings.fxWeather).
(() => {
  "use strict";
  if (window.PcmWeather) return;
  const root = document.documentElement;

  // ---------- the weather along the way (p = tracked / estimate) ----------
  // Between two points everything blends, so the sky changes a little every minute.
  const K = [
    [0.00, { top: "#8da2b8", bot: "#d9e2ea", sun: 0, cloud: .95, dark: .15, snow: 1, rain: 0, wind: .15, light: 0, volc: 0, ground: "#f4f7fa", cap: 1, birds: 0, icon: "❄️", label: "Snowy start" }],
    [0.30, { top: "#9db6cc", bot: "#e4ebf1", sun: .05, cloud: .8, dark: .1, snow: .6, rain: 0, wind: .1, light: 0, volc: 0, ground: "#eef3f6", cap: 1, birds: 0, icon: "🌨️", label: "Snow easing off" }],
    [0.55, { top: "#7fb6e8", bot: "#e3f0f9", sun: .45, cloud: .5, dark: 0, snow: .06, rain: 0, wind: .05, light: 0, volc: 0, ground: "#cfe3c4", cap: .8, birds: 0, icon: "⛅", label: "Clearing up" }],
    [0.80, { top: "#4fa6f0", bot: "#d3ecfb", sun: .85, cloud: .25, dark: 0, snow: 0, rain: 0, wind: .05, light: 0, volc: 0, ground: "#9fd08a", cap: .6, birds: .3, icon: "🌤️", label: "The sun's out" }],
    [0.97, { top: "#2f95f0", bot: "#bfe6ff", sun: 1, cloud: .06, dark: 0, snow: 0, rain: 0, wind: .03, light: 0, volc: 0, ground: "#7cc46a", cap: .5, birds: 1, icon: "☀️", label: "Perfect weather" }],
    [1.07, { top: "#2f95f0", bot: "#bfe6ff", sun: 1, cloud: .08, dark: 0, snow: 0, rain: 0, wind: .03, light: 0, volc: 0, ground: "#7cc46a", cap: .5, birds: 1, icon: "☀️", label: "Perfect weather" }],
    [1.20, { top: "#8ea3b6", bot: "#cfd8df", sun: .35, cloud: .65, dark: .25, snow: 0, rain: 0, wind: .2, light: 0, volc: 0, ground: "#79a86b", cap: .5, birds: 0, icon: "🌥️", label: "Clouding over" }],
    [1.40, { top: "#66798a", bot: "#a7b2bb", sun: .05, cloud: .95, dark: .5, snow: 0, rain: .35, wind: .25, light: 0, volc: 0, ground: "#5e8456", cap: .5, birds: 0, icon: "🌧️", label: "Rain" }],
    [1.70, { top: "#3d4a57", bot: "#6f7a83", sun: 0, cloud: 1, dark: .75, snow: 0, rain: .8, wind: .7, light: .05, volc: 0, ground: "#45603f", cap: .5, birds: 0, icon: "🌧️", label: "Heavy rain and wind" }],
    [2.00, { top: "#1f2630", bot: "#444c55", sun: 0, cloud: 1, dark: .95, snow: 0, rain: 1, wind: .9, light: .7, volc: 0, ground: "#33452f", cap: .4, birds: 0, icon: "⛈️", label: "Thunderstorm" }],
    [2.30, { top: "#3a0f0a", bot: "#8a2c12", sun: 0, cloud: .85, dark: .8, snow: 0, rain: .05, wind: .4, light: .3, volc: 1, ground: "#1e1612", cap: 0, birds: 0, icon: "🌋", label: "The volcano is erupting" }],
  ];
  // No timer: a full moon night with stars (and now and then a UFO). Starting a
  // timer rolls clouds in and the snow begins; completing or stopping it rolls
  // them in again and clears to the night - so every task is one full cycle.
  const IDLE = { top: "#0a1030", bot: "#27325a", sun: 0, cloud: .1, dark: 0, snow: 0, rain: 0, wind: .03, light: 0, volc: 0, ground: "#1d2a33", cap: .55, birds: 0, stars: 1, moon: 1, ufo: 1, icon: "🌕", label: "Full moon night" };
  const FAIR = { ...IDLE, top: "#86bdf0", bot: "#e2f1fb", sun: .7, cloud: .3, wind: .08, ground: "#a3d18f", cap: .7, birds: .4, stars: 0, moon: 0, ufo: 0, icon: "🌤️", label: "Fair weather" };
  // Between two scenes (a timer starting, stopping, or switching task): blend
  // from what's on screen to the new weather, with the clouds peaking halfway so
  // the change happens behind them.
  const TRANS_MS = 5000;
  function blend(a, b, t) {
    const o = {};
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const x = a[k], y = b[k];
      if (typeof x === "number" || typeof y === "number") o[k] = (Number(x) || 0) + ((Number(y) || 0) - (Number(x) || 0)) * t;
      else if (/^#/.test(x || "") && /^#/.test(y || "")) o[k] = mixC(x, y, t);
      else o[k] = t < .5 ? x : y;
    }
    const bump = Math.sin(Math.PI * t);
    o.cloud = Math.max(o.cloud, bump);
    o.dark = Math.max(o.dark, bump * .35);
    return o;
  }
  const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
  const mixC = (a, b, t) => { const x = hex(a), y = hex(b); return "#" + x.map((v, i) => Math.round(v + (y[i] - v) * t).toString(16).padStart(2, "0")).join(""); };
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  function weatherAt(p) {
    if (p == null) return IDLE;
    if (p <= K[0][0]) return K[0][1];
    for (let i = 1; i < K.length; i++) {
      if (p <= K[i][0]) {
        const [p0, a] = K[i - 1], [p1, b] = K[i], t = (p - p0) / (p1 - p0);
        const o = {};
        for (const k of Object.keys(a)) o[k] = typeof a[k] === "number" ? a[k] + (b[k] - a[k]) * t : /^#/.test(a[k]) ? mixC(a[k], b[k], t) : (t < .5 ? a[k] : b[k]);
        return o;
      }
    }
    return K[K.length - 1][1];
  }

  // ---------- the timer it follows ----------
  // clickupState.running = the live timer; runningProgress = its time from before
  // (yours and anyone else's - the estimate is the task's) and its estimate.
  let run = null, rp = null, preview = null;
  function load() {
    try {
      chrome.storage.local.get(["clickupState", "runningProgress"]).then((g) => {
        const st = (g && g.clickupState) || {};
        run = st.running && st.running.taskId ? st.running : null;
        rp = g && g.runningProgress && run && String(g.runningProgress.taskId) === String(run.taskId) ? g.runningProgress : null;
        dirty = true;
      }).catch(() => {});
    } catch (e) {}
  }
  function progress() {
    if (preview === "night") return { p: null, preview: true };
    if (preview != null) return { p: preview, tracked: 0, est: 0, preview: true };
    if (!run) return { p: null };
    const est = rp ? Number(rp.estimateMs) || 0 : 0;
    const tracked = (rp ? Number(rp.closedMs) || 0 : 0) + Math.max(0, Date.now() - (Number(run.startMs) || Date.now()));
    if (!est) return { p: undefined, tracked, est: 0 };
    return { p: tracked / est, tracked, est };
  }
  const fmt = (ms) => { const m = Math.round(Math.max(0, ms) / 60000); const h = Math.floor(m / 60); return h ? h + "h" + (m % 60 ? " " + (m % 60) + "m" : "") : m + "m"; };
  function forecast() {
    const g = progress();
    const w = g.p === undefined ? FAIR : weatherAt(g.p);
    let text = w.icon + " " + w.label;
    if (g.preview) text += " · preview" + (g.p == null ? "" : " " + Math.round(g.p * 100) + "%");
    else if (g.p == null) text += " · no timer running";
    else if (g.p === undefined) text += " · " + fmt(g.tracked) + ", no estimate";
    else text += " · " + fmt(g.tracked) + " of " + fmt(g.est);
    return { text, w, g };
  }

  // ---------- drawing ----------
  let on = false, cv = null, ctx = null, W = 0, H = 0, raf = 0, last = 0, dirty = true, t0 = performance.now();
  let motion = true;
  // themeWeather.strength 0-100 (default 70): how strong the scene is - lower =
  // a calmer, veiled scene. (The cards' own see-through is themeCards.)
  let strength = 70;
  function applyStrength(v) {
    strength = Math.max(0, Math.min(100, Number.isFinite(Number(v)) ? Number(v) : 70));
    dirty = true;
  }
  applyStrength(70);
  const reduced = () => { try { return window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch (e) { return false; } };
  const rnd = (a, b) => a + Math.random() * (b - a);
  let flakes = [], drops = [], ash = [], embers = [], clouds = [], birds = [], stars = [];
  // The night's visitor: a UFO crosses the sky every 25-70 seconds.
  let ufo = null, nextUfo = 0;
  // The scene change in progress: { from (what was on screen), key, start }.
  let trans = null, sceneKey = "", lastW = null;
  let flash = 0, bolt = null;
  function seed() {
    const small = W * H < 500000;
    const n = small ? 70 : 140;
    flakes = Array.from({ length: n }, () => ({ x: rnd(0, W), y: rnd(0, H), r: rnd(1, 3.2), v: rnd(.35, 1.1), s: rnd(0, 6.28) }));
    drops = Array.from({ length: Math.round(n * 1.1) }, () => ({ x: rnd(0, W), y: rnd(0, H), l: rnd(9, 18), v: rnd(9, 14) }));
    ash = Array.from({ length: Math.round(n * .6) }, () => ({ x: rnd(0, W), y: rnd(0, H), r: rnd(.8, 2.2), v: rnd(.3, .8) }));
    embers = Array.from({ length: small ? 26 : 50 }, () => newEmber(true));
    clouds = Array.from({ length: small ? 7 : 11 }, (_, i) => ({ x: rnd(-.2, 1.1) * W, y: rnd(.03, .32) * H, k: rnd(.6, 1.35), v: rnd(.08, .22), o: i }));
    birds = Array.from({ length: 5 }, () => ({ x: rnd(0, W), y: rnd(.12, .3) * H, v: rnd(.3, .6), f: rnd(0, 6.28) }));
    stars = Array.from({ length: small ? 80 : 170 }, () => ({ x: rnd(0, W), y: rnd(0, H * .7), r: rnd(.5, 1.7), f: rnd(0, 6.28), sp: rnd(.6, 2.2) }));
  }
  const groundY = () => H * .86;
  const volcano = () => ({ x: W * .84, top: groundY() - Math.min(H * .34, 260), half: Math.min(W * .22, 320) });
  function newEmber(any) {
    const v = volcano();
    return { x: v.x + rnd(-14, 14), y: any ? rnd(v.top - 200, v.top) : v.top, vx: rnd(-.9, .9), vy: rnd(-2.6, -1.1), life: rnd(.4, 1) };
  }
  function resize() {
    if (!cv) return;
    const r = Math.min(window.devicePixelRatio || 1, W * H > 1500000 ? 1 : 1.25);
    W = Math.max(1, window.innerWidth); H = Math.max(1, window.innerHeight);
    cv.width = Math.round(W * r); cv.height = Math.round(H * r);
    ctx.setTransform(r, 0, 0, r, 0, 0);
    seed();
    dirty = true;
  }
  function cloudShape(x, y, k, col, a) {
    ctx.fillStyle = col;
    ctx.globalAlpha = a;
    ctx.beginPath();
    const parts = [[0, 0, 34], [30, -14, 30], [62, -4, 34], [92, 6, 24], [-28, 8, 22], [40, 14, 30]];
    for (const [dx, dy, r] of parts) { ctx.moveTo(x + dx * k + r * k, y + dy * k); ctx.arc(x + dx * k, y + dy * k, r * k, 0, Math.PI * 2); }
    ctx.fill();
    ctx.globalAlpha = 1;
  }
  function hills(col, y0, amp, freq, phase) {
    ctx.fillStyle = col;
    ctx.beginPath();
    ctx.moveTo(0, H);
    for (let x = 0; x <= W + 20; x += 20) ctx.lineTo(x, y0 + Math.sin(x * freq + phase) * amp + Math.sin(x * freq * 2.7 + phase) * amp * .35);
    ctx.lineTo(W, H);
    ctx.closePath();
    ctx.fill();
  }
  // The weather to draw now: the timer's, or part-way through a change of scene.
  function sceneAt(now, target, key) {
    // A timer starting, stopping or switching task: clouds roll in and the new
    // weather comes out from behind them.
    if (key !== sceneKey) {
      if (sceneKey && lastW && motion) trans = { from: lastW, start: now };
      sceneKey = key;
    }
    let w = target;
    if (trans) {
      const t = (now - trans.start) / TRANS_MS;
      if (t >= 1) trans = null;
      else w = blend(trans.from, target, t * t * (3 - 2 * t));
    }
    lastW = w;
    return w;
  }
  function draw(now) {
    const key = preview === "night" ? "preview-night" : preview != null ? "preview" : run ? String(run.taskId) + ":" + String(run.startMs || "") : "idle";
    const w = sceneAt(now, forecast().w, key);
    const time = (now - t0) / 1000;
    const night = Number(w.stars) || 0;
    const dark = root.dataset.theme === "dark";
    // Sky
    const sky = ctx.createLinearGradient(0, 0, 0, H);
    sky.addColorStop(0, w.top); sky.addColorStop(1, w.bot);
    ctx.fillStyle = sky; ctx.fillRect(0, 0, W, H);
    // Stars and the full moon (no timer running).
    if (night > .02) {
      for (const st of stars) {
        const tw = motion ? .55 + .45 * Math.sin(time * st.sp + st.f) : .8;
        ctx.fillStyle = "rgba(255,255,240," + (night * tw) + ")";
        ctx.fillRect(st.x, st.y, st.r, st.r);
      }
    }
    const moon = Number(w.moon) || 0;
    if (moon > .02) {
      const mx = W * .9, my = H * .13, mr = Math.min(44, Math.max(26, W * .024));
      const halo = ctx.createRadialGradient(mx, my, mr * .8, mx, my, mr * 5);
      halo.addColorStop(0, "rgba(220,230,255," + (.35 * moon) + ")"); halo.addColorStop(1, "rgba(220,230,255,0)");
      ctx.fillStyle = halo; ctx.fillRect(mx - mr * 5, my - mr * 5, mr * 10, mr * 10);
      ctx.fillStyle = "rgba(246,243,228," + moon + ")";
      ctx.beginPath(); ctx.arc(mx, my, mr, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "rgba(200,196,178," + (.5 * moon) + ")"; // its seas
      for (const [dx, dy, k] of [[-.3, -.2, .22], [.25, .1, .18], [-.05, .35, .14], [.3, -.35, .1]]) { ctx.beginPath(); ctx.arc(mx + dx * mr, my + dy * mr, k * mr, 0, Math.PI * 2); ctx.fill(); }
    }
    // The UFO: glides across now and then, lights blinking, a faint beam halfway.
    if ((Number(w.ufo) || 0) > .5 && motion) {
      if (!ufo && !nextUfo) nextUfo = now + rnd(6000, 20000);
      if (!ufo && now >= nextUfo) { const dir = Math.random() < .5 ? 1 : -1; ufo = { dir, start: now, dur: rnd(9000, 13000), y: rnd(.1, .3) * H }; }
    }
    if (ufo) {
      const t = (now - ufo.start) / ufo.dur;
      if (t >= 1 || (Number(w.ufo) || 0) < .5) { ufo = null; nextUfo = now + rnd(25000, 70000); }
      else {
        const ux = ufo.dir > 0 ? -60 + (W + 120) * t : W + 60 - (W + 120) * t, uy = ufo.y + Math.sin(t * 18) * 6, a = Math.min(1, night * 1.2);
        if (t > .42 && t < .58) { // the beam
          const bA = Math.sin((t - .42) / .16 * Math.PI) * .22 * a;
          const bm = ctx.createLinearGradient(0, uy, 0, groundY());
          bm.addColorStop(0, "rgba(170,255,200," + bA + ")"); bm.addColorStop(1, "rgba(170,255,200,0)");
          ctx.fillStyle = bm; ctx.beginPath(); ctx.moveTo(ux - 8, uy + 6); ctx.lineTo(ux + 8, uy + 6); ctx.lineTo(ux + 46, groundY()); ctx.lineTo(ux - 46, groundY()); ctx.fill();
        }
        ctx.globalAlpha = a;
        ctx.fillStyle = "rgba(170,230,255,.75)"; ctx.beginPath(); ctx.ellipse(ux, uy - 5, 11, 9, 0, Math.PI, 0); ctx.fill();
        ctx.fillStyle = "#9aa3b5"; ctx.beginPath(); ctx.ellipse(ux, uy, 28, 7, 0, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = "#5f6779"; ctx.beginPath(); ctx.ellipse(ux, uy + 2, 20, 3.5, 0, 0, Math.PI * 2); ctx.fill();
        for (let i = -2; i <= 2; i++) { ctx.fillStyle = Math.floor(time * 4 + i) % 2 ? "#ffe066" : "#ff6b6b"; ctx.fillRect(ux + i * 10 - 1.5, uy - 1.5, 3, 3); }
        ctx.globalAlpha = 1;
      }
    }
    // Sun: rises as the task nears its estimate.
    if (w.sun > .01) {
      const sx = W * .76, sy = groundY() - (groundY() - H * .12) * clamp(w.sun, 0, 1), R = Math.min(W, H) * .32;
      const g = ctx.createRadialGradient(sx, sy, 0, sx, sy, R);
      g.addColorStop(0, "rgba(255,244,200," + (.85 * w.sun) + ")"); g.addColorStop(.18, "rgba(255,226,140," + (.45 * w.sun) + ")"); g.addColorStop(1, "rgba(255,220,140,0)");
      ctx.fillStyle = g; ctx.fillRect(sx - R, sy - R, R * 2, R * 2);
      ctx.fillStyle = "rgba(255,236,170," + w.sun + ")";
      ctx.beginPath(); ctx.arc(sx, sy, Math.min(46, Math.max(26, W * .025)), 0, Math.PI * 2); ctx.fill();
    }
    // The mountains (the right one is the volcano: snow-capped while it sleeps).
    const v = volcano(), gy = groundY();
    const mcol = mixC(mixC(mixC("#8b9bb0", "#55606e", w.dark), "#2a1712", w.volc), "#1a2238", night * .75);
    ctx.fillStyle = mixC(mcol, w.bot, .35);
    ctx.beginPath(); ctx.moveTo(W * .02, gy); ctx.lineTo(W * .16, gy - Math.min(H * .22, 170)); ctx.lineTo(W * .32, gy); ctx.fill();
    ctx.fillStyle = mcol;
    ctx.beginPath(); ctx.moveTo(v.x - v.half, gy); ctx.lineTo(v.x - 18, v.top); ctx.lineTo(v.x + 18, v.top); ctx.lineTo(v.x + v.half, gy); ctx.fill();
    if (w.cap > .02) {
      ctx.fillStyle = "rgba(250,252,255," + (.9 * w.cap) + ")";
      const ch = (gy - v.top) * .22, cw = v.half * .22;
      ctx.beginPath(); ctx.moveTo(v.x - 18 - cw, v.top + ch); ctx.lineTo(v.x - 18, v.top); ctx.lineTo(v.x + 18, v.top); ctx.lineTo(v.x + 18 + cw, v.top + ch);
      for (let i = 4; i >= 0; i--) ctx.lineTo(v.x - 18 - cw + (36 + cw * 2) * i / 4, v.top + ch + (i % 2 ? -8 : 4));
      ctx.fill();
    }
    if (w.volc > .02) {
      // Lava glow at the crater and streams down the side.
      const gl = ctx.createRadialGradient(v.x, v.top, 0, v.x, v.top, 160);
      gl.addColorStop(0, "rgba(255,140,40," + (.9 * w.volc) + ")"); gl.addColorStop(1, "rgba(255,80,20,0)");
      ctx.fillStyle = gl; ctx.fillRect(v.x - 160, v.top - 160, 320, 320);
      ctx.strokeStyle = "rgba(255,110,30," + (.85 * w.volc) + ")"; ctx.lineWidth = 3;
      for (const s of [-1, 1]) { ctx.beginPath(); ctx.moveTo(v.x + s * 8, v.top + 2); ctx.quadraticCurveTo(v.x + s * v.half * .3, v.top + (gy - v.top) * .5, v.x + s * v.half * .45 + Math.sin(time) * 3, gy - 4); ctx.stroke(); }
      // Smoke plume.
      for (let i = 0; i < 6; i++) cloudShape(v.x - 40 + Math.sin(time * .3 + i) * 20 + i * 8, v.top - 40 - i * 34, .6 + i * .18, "#2b2220", .5 * w.volc);
    }
    // Clouds: more of them, and darker, as the weather turns.
    const ccol = mixC(mixC("#ffffff", "#3c434c", w.dark), "#4a5378", night * .7);
    const nC = Math.round(clouds.length * clamp(w.cloud, 0, 1));
    for (let i = 0; i < nC; i++) {
      const c = clouds[i];
      if (motion) { c.x += (c.v + w.wind * 1.2) * .6; if (c.x > W + 160) { c.x = -200; c.y = rnd(.03, .32) * H; } }
      cloudShape(c.x, c.y, c.k * (1 + w.cloud * .4), ccol, .55 + .4 * w.cloud);
    }
    if (w.dark > .05) { ctx.fillStyle = "rgba(20,24,30," + (w.dark * .28) + ")"; ctx.fillRect(0, 0, W, H); }
    // Birds on a perfect day.
    if (w.birds > .05) {
      ctx.strokeStyle = "rgba(40,50,60," + (.6 * w.birds) + ")"; ctx.lineWidth = 1.6;
      for (const b of birds) {
        if (motion) { b.x += b.v; if (b.x > W + 20) { b.x = -20; b.y = rnd(.12, .3) * H; } }
        const f = Math.sin(time * 6 + b.f) * 4;
        ctx.beginPath(); ctx.moveTo(b.x - 8, b.y - f); ctx.quadraticCurveTo(b.x - 3, b.y - 2, b.x, b.y); ctx.quadraticCurveTo(b.x + 3, b.y - 2, b.x + 8, b.y - f); ctx.stroke();
      }
    }
    // The ground: snow, then grass, then wet, then scorched.
    hills(mixC(w.ground, "#000000", .12), gy + 6, 10, .006, 1.3);
    hills(w.ground, gy + 22, 8, .009, 0);
    // Snow
    const nS = Math.round(flakes.length * clamp(w.snow, 0, 1));
    if (nS) {
      ctx.fillStyle = "rgba(255,255,255,.92)";
      for (let i = 0; i < nS; i++) {
        const f = flakes[i];
        if (motion) { f.y += f.v; f.x += Math.sin(time + f.s) * .35 + w.wind * .8; if (f.y > H) { f.y = -4; f.x = rnd(0, W); } if (f.x > W) f.x = 0; }
        ctx.beginPath(); ctx.arc(f.x, f.y, f.r, 0, Math.PI * 2); ctx.fill();
      }
    }
    // Rain, slanted by the wind.
    const nR = Math.round(drops.length * clamp(w.rain, 0, 1));
    if (nR) {
      ctx.strokeStyle = "rgba(200,215,235," + (.35 + .3 * w.rain) + ")"; ctx.lineWidth = 1.1;
      ctx.beginPath();
      const sl = w.wind * 6;
      for (let i = 0; i < nR; i++) {
        const d = drops[i];
        if (motion) { d.y += d.v; d.x += sl * .6; if (d.y > H) { d.y = -20; d.x = rnd(-40, W); } if (d.x > W + 20) d.x = -20; }
        ctx.moveTo(d.x, d.y); ctx.lineTo(d.x - sl, d.y - d.l);
      }
      ctx.stroke();
    }
    // Ash falls and embers fly when the volcano erupts.
    if (w.volc > .02) {
      ctx.fillStyle = "rgba(70,60,58," + (.7 * w.volc) + ")";
      for (const a of ash) { if (motion) { a.y += a.v; a.x += w.wind * .5; if (a.y > H) { a.y = -4; a.x = rnd(0, W); } } ctx.fillRect(a.x, a.y, a.r, a.r); }
      for (let i = 0; i < embers.length; i++) {
        const e = embers[i];
        if (motion) { e.x += e.vx; e.y += e.vy; e.vy += .025; e.life -= .008; if (e.life <= 0 || e.y > groundY()) embers[i] = newEmber(false); }
        ctx.fillStyle = "rgba(255," + Math.round(120 + 100 * e.life) + ",40," + (w.volc * clamp(e.life, 0, 1)) + ")";
        ctx.fillRect(e.x, e.y, 2.4, 2.4);
      }
    }
    // Lightning.
    if (w.light > .02 && motion && flash <= 0 && Math.random() < w.light * .008) {
      flash = 1;
      let x = rnd(W * .1, W * .9), y = H * .1;
      bolt = [[x, y]];
      while (y < groundY()) { x += rnd(-30, 30); y += rnd(18, 40); bolt.push([x, y]); }
    }
    if (flash > 0) {
      ctx.fillStyle = "rgba(255,255,255," + (flash * .35) + ")"; ctx.fillRect(0, 0, W, H);
      if (bolt) { ctx.strokeStyle = "rgba(255,255,230," + flash + ")"; ctx.lineWidth = 2.2; ctx.beginPath(); bolt.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.stroke(); }
      flash -= .08;
    }
    // Dark mode: the same weather at dusk, so light text stays readable.
    if (dark) { ctx.fillStyle = "rgba(8,11,16," + (.52 * (1 - .7 * night)) + ")"; ctx.fillRect(0, 0, W, H); }
    // Weather strength (☀ menu / Appearance): lower lays a soft veil over the
    // scene so the text on and around the cards reads easily.
    const veil = (100 - strength) / 100 * .6;
    if (veil > .01) { ctx.fillStyle = dark ? "rgba(15,17,21," + veil + ")" : "rgba(244,240,233," + veil + ")"; ctx.fillRect(0, 0, W, H); }
    paintChips();
  }
  function loop(now) {
    raf = 0;
    if (!on) return;
    if (document.hidden) return; // resumed on visibilitychange
    const still = !motion && !trans;
    if (still ? (dirty || now - last > 20000) : now - last > 33) { last = now; dirty = false; draw(now); }
    raf = requestAnimationFrame(loop);
  }
  function kick() { if (on && !raf && !document.hidden) raf = requestAnimationFrame(loop); }

  // ---------- the forecast line (the empty space under the sidebar / the bottom of the popup) ----------
  let chipText = "";
  function paintChips() {
    const f = forecast();
    if (f.text === chipText) return;
    chipText = f.text;
    document.querySelectorAll(".pcm-wx-chip").forEach((el) => { el.textContent = f.text; el.title = "Task weather: the running task's time against its estimate - snow at the start, sun on the estimate, storms past it. Change it with the ☀ button (Background)."; });
  }
  function placeChips() {
    if (document.querySelector(".pcm-wx-chip")) return;
    const nav = document.getElementById("sideNav");
    const chip = document.createElement("div");
    chip.className = "pcm-wx-chip";
    if (nav) nav.appendChild(chip); // options: under the sidebar menu
    else { chip.classList.add("pcm-wx-foot"); document.body.appendChild(chip); } // popup / side panel: at the bottom
    chipText = "";
  }
  const css = document.createElement("style");
  css.textContent = `
  #pcmSky { position: fixed; inset: 0; width: 100vw; height: 100vh; z-index: -1; pointer-events: none; display: block; }
  html.pcm-sky { background: #8da2b8; }
  html.pcm-sky body { background: transparent !important; }
  html.pcm-sky .card, html.pcm-sky .sidenav { background: color-mix(in srgb, var(--card) var(--pcm-glass, 84%), transparent) !important; backdrop-filter: blur(8px); }
  /* Text that sits straight on the sky (or a wallpaper) gets a soft halo of the
     card colour, and strips that aren't cards the same glass, so a stormy or
     volcanic sky never makes them hard to read. */
  /* Fits its text (not the whole row) and ends where the text ends, so it never
     runs over the status pills below. */
  html.pcm-sky .pagehead > div:first-child, html.pcm-wall .pagehead > div:first-child { flex: 0 1 auto; margin: -6px auto 6px -12px; background: color-mix(in srgb, var(--card) var(--pcm-glass, 84%), transparent); backdrop-filter: blur(8px); border-radius: 12px; padding: 6px 12px 7px; }
  html.pcm-sky .pagehead > div:first-child .sub, html.pcm-wall .pagehead > div:first-child .sub { margin-bottom: 0; }
  html.pcm-sky .header, html.pcm-wall .header { background: color-mix(in srgb, var(--card) 80%, transparent); backdrop-filter: blur(8px); border-radius: 11px; padding: 6px 8px; margin: -4px -6px 6px; width: auto; }
  html.pcm-sky .header { background: color-mix(in srgb, var(--card) var(--pcm-glass, 84%), transparent); }
  html.pcm-sky .pcm-dash-strip, html.pcm-wall .pcm-dash-strip { background: color-mix(in srgb, var(--card) var(--pcm-glass, 84%), transparent) !important; backdrop-filter: blur(8px); }
  .pcm-wx-chip { display: none; }
  html.pcm-sky .pcm-wx-chip { display: block; margin-top: 8px; padding: 7px 9px; border-radius: 10px; font-size: 11.5px; line-height: 1.35; color: var(--text); background: color-mix(in srgb, var(--card) 70%, transparent); border: 1px solid var(--border); overflow-wrap: anywhere; }
  html.pcm-sky .pcm-wx-chip.pcm-wx-foot { margin: 10px 0 0; text-align: center; }
  @media (max-width: 860px) { html.pcm-sky .sidenav .pcm-wx-chip { display: none; } }`;
  (document.head || document.documentElement).appendChild(css);

  function start() {
    if (on) return;
    on = true;
    root.classList.add("pcm-sky");
    if (!cv) {
      cv = document.createElement("canvas");
      cv.id = "pcmSky";
      cv.setAttribute("aria-hidden", "true");
      ctx = cv.getContext("2d");
    }
    (document.body || document.documentElement).prepend(cv);
    resize();
    placeChips();
    load();
    kick();
  }
  function stop() {
    if (!on) return;
    on = false;
    root.classList.remove("pcm-sky");
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    if (cv) cv.remove();
  }
  function applySettings(st) {
    motion = !reduced() && !(st && st.fxWeather === false);
    dirty = true;
  }
  window.addEventListener("resize", () => { if (on) resize(); });
  document.addEventListener("visibilitychange", () => { if (!document.hidden) { dirty = true; kick(); } });
  try {
    chrome.storage.local.get("settings").then((g) => applySettings(g && g.settings)).catch(() => applySettings({}));
    chrome.storage.local.get("themeWeather").then((g) => applyStrength(g && g.themeWeather && g.themeWeather.strength)).catch(() => {});
    chrome.storage.onChanged.addListener((ch, area) => {
      if (area !== "local") return;
      if (ch.clickupState || ch.runningProgress) load();
      if (ch.settings) applySettings(ch.settings.newValue);
      if (ch.themeWeather) applyStrength(ch.themeWeather.newValue && ch.themeWeather.newValue.strength);
    });
  } catch (e) { applySettings({}); }
  window.PcmWeather = {
    start, stop, weatherAt, forecast,
    get on() { return on; },
    get transitioning() { return !!trans; },
    get strength() { return strength; },
    setStrength(v) { applyStrength(v); try { chrome.storage.local.set({ themeWeather: { strength } }); } catch (e) {} },
    sceneAt, // for the tests
    // Options › Appearance › Preview: p = tracked / estimate (null = the real timer).
    // "night" = the no-timer night (the Play demo starts and ends there).
    preview(p) { preview = p == null ? null : p === "night" ? "night" : clamp(Number(p) || 0, 0, 3); dirty = true; chipText = ""; },
  };
})();
