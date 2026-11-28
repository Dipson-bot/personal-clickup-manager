// Guide › Connect ClickUp: plays the drawn walkthrough like a short video - the
// pointer moves to what each step clicks (found on the page, not guessed), clicks
// it, the next screen fades in. Loops; pauses while the Guide isn't on screen.
// No real account or key appears: these are drawings with a made-up token.
(() => {
  const box = document.getElementById("gdDemo");
  if (!box) return;
  const cur = box.querySelector(".gd-cursor"), cap = box.querySelector(".gd-cap"), dots = box.querySelector(".gd-dots");
  const scenes = Object.fromEntries([...box.querySelectorAll(".gd-scene")].map((s) => [s.dataset.scene, s]));
  // scene, the element to point at, what happens, the caption.
  const STEPS = [
    { scene: "cu-home", t: "avatar", cap: "1 · In ClickUp (app or browser), click your profile picture, top right" },
    { scene: "cu-home", t: "prefs", cap: "2 · Click Preferences", before: (s) => s.classList.add("menu-open") },
    { scene: "cu-settings", t: "api", cap: "3 · In All settings › left sidebar, click ClickUp API" },
    { scene: "cu-settings", t: "token", cap: "4 · Under API tokens, copy your token (no token yet? Create token)", before: (s) => s.classList.add("api-open") },
    { scene: "ext-setup", t: "field", cap: "5 · Here: ClickUp setup › paste it into ClickUp personal API token", type: true },
    { scene: "ext-setup", t: "save", cap: "6 · Press Save & connect" },
    { scene: "ext-done", t: null, cap: "7 · Connected - pick your workspace and your day appears", hold: 2600 },
  ];
  dots.innerHTML = STEPS.map(() => "<i></i>").join("");
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  let running = false, gen = 0;

  const show = (name) => { for (const [k, s] of Object.entries(scenes)) s.classList.toggle("on", k === name); };
  const reset = () => { for (const s of Object.values(scenes)) s.classList.remove("menu-open", "api-open", "typed", "copied", "saved"); box.querySelectorAll(".hit").forEach((e) => e.classList.remove("hit")); };
  function pointAt(el) {
    if (!el) return;
    const b = box.getBoundingClientRect(), r = el.getBoundingClientRect();
    cur.style.left = (r.left - b.left + Math.min(r.width * 0.5, 40)) + "px";
    cur.style.top = (r.top - b.top + r.height * 0.55) + "px";
  }
  async function play(g) {
    for (let i = 0; i < STEPS.length; i++) {
      if (g !== gen) return;
      const st = STEPS[i], sc = scenes[st.scene];
      if (i === 0) reset();
      show(st.scene);
      if (st.before) st.before(sc);
      cap.textContent = st.cap;
      dots.querySelectorAll("i").forEach((d, k) => d.classList.toggle("on", k === i));
      await wait(reduce ? 200 : 450);
      const el = st.t ? sc.querySelector('[data-t="' + st.t + '"]') : null;
      if (el && !reduce) { pointAt(el); await wait(950); }
      if (g !== gen) return;
      if (el) {
        el.classList.add("hit");
        cur.classList.add("click");
        setTimeout(() => cur.classList.remove("click"), 300);
        if (st.t === "token") sc.classList.add("copied");
        if (st.type) { sc.classList.add("typed"); await wait(reduce ? 200 : 1300); }
        if (st.t === "save") sc.classList.add("saved");
      }
      await wait(reduce ? 2600 : (st.hold || 1500));
      if (el) el.classList.remove("hit");
    }
  }
  async function loop() {
    if (running) return;
    running = true;
    const g = ++gen;
    while (g === gen && visible()) { await play(g); await wait(600); }
    running = false;
  }
  const visible = () => box.offsetParent !== null && document.visibilityState === "visible";
  const kick = () => { if (visible()) loop(); else gen++; };
  new IntersectionObserver((e) => { if (e.some((x) => x.isIntersecting)) kick(); else gen++; }).observe(box);
  document.addEventListener("visibilitychange", kick);
  show("cu-home");
})();
