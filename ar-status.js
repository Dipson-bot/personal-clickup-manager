// Agent Router: what can be used right now, on the Accounts card (dashboard's
// Agent Router tab, popup, side panel) - so nobody has to open agentrouter.org to
// find out why Claude Code stopped working. The background reads Agent Router's
// public model list and announcement (storage arStatus, at most every 30 minutes;
// "Check now" asks at once): which models your account's group can use, whether
// any of them is Claude, and the latest notice in English.
(() => {
  if (window.PcmArStatus || typeof chrome === "undefined" || !chrome.storage) return;
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const clock = (ms) => new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  let st = null, busy = false, err = "";
  function box() {
    const card = document.getElementById("accountsCard");
    if (!card) return null;
    let b = card.querySelector(".ars-box");
    if (!b) {
      b = document.createElement("div");
      b.className = "ars-box";
      const list = card.querySelector("#list");
      if (list) list.before(b); else card.appendChild(b);
      b.addEventListener("click", (e) => {
        if (e.target.closest("[data-ars-check]")) { e.preventDefault(); check(true); }
      });
    }
    return b;
  }
  function paint() {
    const b = box();
    if (!b) return;
    if (!st) {
      b.className = "ars-box";
      b.innerHTML = busy ? "Checking what Agent Router offers…" : err ? esc(err) + ' <button type="button" class="ars-btn" data-ars-check>↻ Check now</button>' : "";
      b.hidden = !busy && !err;
      return;
    }
    b.hidden = false;
    const usable = Array.isArray(st.usable) ? st.usable : [];
    const gpt = usable.filter((n) => !/claude/i.test(n));
    const claude = usable.filter((n) => /claude/i.test(n));
    const locked = Array.isArray(st.claudeOnly) ? st.claudeOnly : [];
    let head;
    if (st.claude) {
      head = '<b>✓ Claude is available on Agent Router</b> (' + esc(claude.join(", ")) + ")" + (gpt.length ? ", plus " + esc(gpt.join(", ")) : "") + ".";
    } else {
      head = "<b>⚠ No Claude on Agent Router for your account right now.</b> " +
        (usable.length ? "It can use " + esc(usable.join(", ")) + " (GPT models only), " : "") +
        "so Claude Code through Agent Router won't work" +
        (locked.length ? (() => { const gs = [...new Set(locked.flatMap((m) => m.groups || []))]; return " - " + esc(locked.map((m) => m.name).join(", ")) + (locked.length > 1 ? " are" : " is") + " only open to the " + esc(gs.join(" / ")) + " group" + (gs.length > 1 ? "s" : "") + " (yours: " + esc(st.group || "default") + ")"; })() : "") +
        ". This box changes as soon as Agent Router offers Claude again, and you get a notification.";
    }
    b.className = "ars-box " + (st.claude ? "ok" : "warn");
    b.innerHTML = '<div class="ars-h">' + head + "</div>" +
      (st.notice ? '<details class="ars-n"><summary>Agent Router\'s notice</summary><div class="ars-nt">' + esc(st.notice) + "</div></details>" : "") +
      '<div class="ars-f">Checked ' + clock(st.at) + (busy ? " · checking…" : "") + ' <button type="button" class="ars-btn" data-ars-check' + (busy ? " disabled" : "") + ">↻ Check now</button></div>";
  }
  function check(force) {
    if (busy) return;
    busy = true; err = ""; paint();
    try {
      chrome.runtime.sendMessage({ type: "AR_STATUS", force: !!force }, (r) => {
        void chrome.runtime.lastError;
        busy = false;
        if (r && r.ok && r.status) st = r.status;
        else if (!st) err = "Couldn't read Agent Router just now.";
        paint();
      });
    } catch (e) { busy = false; paint(); }
  }
  chrome.storage.local.get("arStatus").then((g) => { st = (g && g.arStatus) || null; paint(); check(false); }).catch(() => check(false));
  chrome.storage.onChanged.addListener((ch, area) => { if (area === "local" && ch.arStatus) { st = ch.arStatus.newValue || null; paint(); } });
  const css = document.createElement("style");
  css.textContent = `
  .ars-box { margin: 0 0 10px; padding: 8px 10px; border-radius: 9px; font-size: 12px; line-height: 1.45; border: 1px solid var(--border); background: var(--bg2, rgba(0,0,0,.03)); color: var(--text); }
  .ars-box[hidden] { display: none; }
  .ars-box.warn { border-color: rgba(217,119,6,.45); background: rgba(245,158,11,.1); }
  .ars-box.ok { border-color: rgba(22,163,74,.4); background: rgba(34,197,94,.09); }
  .ars-box .ars-h b { font-weight: 700; }
  .ars-box.warn .ars-h b { color: #b45309; }
  .ars-box.ok .ars-h b { color: #15803d; }
  .ars-n { margin-top: 5px; }
  .ars-n summary { cursor: pointer; font-weight: 600; color: var(--muted); }
  .ars-nt { white-space: pre-wrap; margin-top: 4px; padding: 6px 8px; border-radius: 7px; background: var(--card); border: 1px solid var(--border); max-height: 180px; overflow: auto; }
  .ars-f { margin-top: 5px; color: var(--muted); font-size: 11px; display: flex; align-items: center; gap: 8px; }
  .ars-btn { font: inherit; font-size: 11px; padding: 1px 8px; border: 1px solid var(--border); border-radius: 6px; background: var(--card); color: var(--text); cursor: pointer; }
  .ars-btn:hover { border-color: var(--indigo, #6366f1); color: var(--indigo, #6366f1); }
  html[data-theme="dark"] .ars-box.warn .ars-h b { color: #fbbf24; }
  html[data-theme="dark"] .ars-box.ok .ars-h b { color: #4ade80; }`;
  document.head.appendChild(css);
  window.PcmArStatus = { check, get: () => st };
})();
