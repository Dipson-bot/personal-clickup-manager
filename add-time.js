// "+ Add missed time" under the Extra task controls (dashboard, popup, side
// panel): a meeting or extra work you forgot to track, added afterwards as a
// time entry on the Extra task in ClickUp - like ClickUp's own "Add time".
(() => {
  "use strict";
  const send = (msg, ms) => new Promise((ok) => {
    let done = false;
    const to = setTimeout(() => { done = true; ok(null); }, ms || 30000);
    try { chrome.runtime.sendMessage(msg, (r) => { if (done) return; done = true; clearTimeout(to); void chrome.runtime.lastError; ok(r || null); }); } catch (e) { clearTimeout(to); ok(null); }
  });
  const pad = (n) => String(n).padStart(2, "0");
  const ymd = (d) => d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  const hm = (d) => pad(d.getHours()) + ":" + pad(d.getMinutes());
  const fmt = (ms) => { const m = Math.round(ms / 60000); const h = Math.floor(m / 60); return (h ? h + "h " : "") + (m % 60) + "m"; };

  const css = document.createElement("style");
  css.textContent = `
  .amt-link { display: inline-block; margin: 6px 0 2px; padding: 0; border: 0; background: none; font: inherit; font-size: 12px; font-weight: 600; color: var(--indigo, #6366f1); cursor: pointer; }
  .amt-link:hover { text-decoration: underline; }
  .amt-form { margin: 6px 0 4px; padding: 10px; border: 1px solid var(--border, #d4d4d8); border-radius: 9px; background: var(--card, transparent); font-size: 12px; display: flex; flex-direction: column; gap: 8px; }
  .amt-form .amt-r { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 8px; }
  .amt-form label { font-weight: 600; margin: 0; }
  .amt-form input { width: auto; font: inherit; font-size: 12px; padding: 4px 7px; border: 1px solid var(--border, #d4d4d8); border-radius: 6px; background: var(--card, transparent); color: var(--text, inherit); }
  .amt-form input.amt-what { flex: 1 1 160px; min-width: 120px; }
  .amt-form .amt-dur { font-weight: 700; color: var(--green, #16a34a); }
  .amt-form .amt-dur.bad { color: var(--red, #dc2626); }
  .amt-form button { font: inherit; font-size: 12px; font-weight: 600; padding: 4px 12px; border-radius: 7px; border: 1px solid var(--border, #d4d4d8); background: transparent; color: inherit; cursor: pointer; }
  .amt-form button.go { background: var(--indigo, #6366f1); border-color: var(--indigo, #6366f1); color: #fff; }
  .amt-form button:disabled { opacity: .5; cursor: default; }
  .amt-form .amt-msg { font-size: 11.5px; color: var(--muted, #71717a); }
  .amt-form .amt-msg.err { color: var(--red, #dc2626); }
  .amt-form .amt-msg.ok { color: var(--green, #16a34a); }`;
  document.head.appendChild(css);

  function build(host) {
    const link = document.createElement("button");
    link.type = "button";
    link.className = "amt-link";
    link.textContent = "+ Add missed time";
    link.title = "Forgot to track a meeting or extra work? Add it afterwards to the Extra task";
    let form = null;
    link.onclick = () => {
      if (form) { form.remove(); form = null; return; }
      form = document.createElement("div");
      form.className = "amt-form";
      const end = new Date(); end.setSeconds(0, 0); end.setMinutes(Math.floor(end.getMinutes() / 5) * 5);
      const start = new Date(end.getTime() - 30 * 60000);
      form.innerHTML =
        '<div class="amt-r"><label>What was it?</label><input type="text" class="amt-what" maxlength="200" value="Meeting" placeholder="e.g. Meeting with the team"></div>' +
        '<div class="amt-r"><label>Day</label><input type="date" class="amt-day"><label>From</label><input type="time" class="amt-from"><label>to</label><input type="time" class="amt-to"><span class="amt-dur"></span></div>' +
        '<div class="amt-r"><button type="button" class="go">Add to ClickUp</button><button type="button" class="no">Cancel</button><span class="amt-msg"></span></div>';
      const $ = (s) => form.querySelector(s);
      $(".amt-day").value = ymd(end); $(".amt-day").max = ymd(new Date());
      $(".amt-from").value = hm(start); $(".amt-to").value = hm(end);
      const span = () => {
        const d = $(".amt-day").value, f = $(".amt-from").value, t = $(".amt-to").value;
        if (!d || !f || !t) return null;
        const a = new Date(d + "T" + f).getTime(), b = new Date(d + "T" + t).getTime();
        return { a, b };
      };
      const check = () => {
        const s = span(), dur = $(".amt-dur");
        let err = "";
        if (!s) err = "pick a day and both times";
        else if (!(s.b > s.a)) err = "the end must be after the start";
        else if (s.b - s.a > 12 * 3600000) err = "12 hours at most";
        else if (s.b > Date.now() + 60000) err = "that's still in the future";
        dur.textContent = err || "= " + fmt(s.b - s.a);
        dur.className = "amt-dur" + (err ? " bad" : "");
        $(".go").disabled = !!err;
        return err ? null : s;
      };
      form.addEventListener("input", check);
      form.addEventListener("change", check);
      check();
      const msg = (t, k) => { const m = $(".amt-msg"); m.textContent = t; m.className = "amt-msg" + (k ? " " + k : ""); };
      $(".no").onclick = () => { form.remove(); form = null; };
      $(".go").onclick = async () => {
        const s = check();
        if (!s) return;
        $(".go").disabled = true;
        msg("Adding…");
        const r = await send({ type: "CLICKUP_ADD_TIME", startMs: s.a, durationMs: s.b - s.a, description: $(".amt-what").value.trim() }, 30000);
        if (r && r.ok) {
          msg("Added " + fmt(s.b - s.a) + " to " + (r.taskName || "the Extra task") + " ✓ - the totals update in a moment.", "ok");
          setTimeout(() => { if (form) { form.remove(); form = null; } }, 3500);
          return;
        }
        $(".go").disabled = false;
        msg("Couldn't add it: " + ((r && r.error) || "no answer"), "err");
      };
      link.after(form);
      $(".amt-what").focus();
      $(".amt-what").select();
    };
    host.after(link);
  }
  const place = () => {
    const host = document.getElementById("cuXMode");
    if (host && !document.querySelector(".amt-link")) build(host);
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", place); else place();
})();
