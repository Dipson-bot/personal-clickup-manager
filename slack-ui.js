// Slack tab helpers: draw a Slack message as Slack does (links, @people, #channels,
// *bold* _italic_ ~strike~ `code`, :emoji:), and a reply box that can @mention
// people (sent as real Slack mentions), add emoji, and take text pasted from an AI
// chat (Markdown or rich text) in Slack's own format.
(() => {
  const esc = (s) => String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  // Slack's common shortcodes (custom workspace emoji stay as :name:).
  const EMOJI = { smile: "😄", smiley: "😃", grinning: "😀", blush: "😊", wink: "😉", joy: "😂", rofl: "🤣", slightly_smiling_face: "🙂", upside_down_face: "🙃", sweat_smile: "😅", laughing: "😆", heart_eyes: "😍", thinking_face: "🤔", neutral_face: "😐", expressionless: "😑", unamused: "😒", rolling_eyes: "🙄", grimacing: "😬", relieved: "😌", pensive: "😔", confused: "😕", worried: "😟", cry: "😢", sob: "😭", angry: "😠", rage: "😡", scream: "😱", flushed: "😳", sunglasses: "😎", nerd_face: "🤓", star_struck: "🤩", partying_face: "🥳", pray: "🙏", clap: "👏", raised_hands: "🙌", "+1": "👍", thumbsup: "👍", "-1": "👎", thumbsdown: "👎", ok_hand: "👌", wave: "👋", muscle: "💪", point_up: "☝️", point_right: "👉", point_left: "👈", eyes: "👀", heart: "❤️", fire: "🔥", tada: "🎉", rocket: "🚀", star: "⭐", sparkles: "✨", white_check_mark: "✅", heavy_check_mark: "✔️", ballot_box_with_check: "☑️", x: "❌", warning: "⚠️", rotating_light: "🚨", exclamation: "❗", question: "❓", bulb: "💡", memo: "📝", pushpin: "📌", link: "🔗", calendar: "📅", hourglass: "⌛", stopwatch: "⏱️", alarm_clock: "⏰", chart_with_upwards_trend: "📈", chart_with_downwards_trend: "📉", bar_chart: "📊", mag: "🔍", lock: "🔒", key: "🔑", gear: "⚙️", hammer_and_wrench: "🛠️", wrench: "🔧", bug: "🐛", computer: "💻", phone: "📞", email: "📧", envelope: "✉️", inbox_tray: "📥", outbox_tray: "📤", page_facing_up: "📄", clipboard: "📋", folder: "📁", moneybag: "💰", dollar: "💵", trophy: "🏆", medal: "🏅", 100: "💯", zap: "⚡", boom: "💥", coffee: "☕", sunny: "☀️", cloud: "☁️", red_circle: "🔴", large_green_circle: "🟢", large_yellow_circle: "🟡", large_blue_circle: "🔵", black_circle: "⚫", white_circle: "⚪", arrow_right: "➡️", arrow_left: "⬅️", arrow_up: "⬆️", arrow_down: "⬇️", heavy_plus_sign: "➕", heavy_minus_sign: "➖", raising_hand: "🙋", man_facepalming: "🤦‍♂️", woman_facepalming: "🤦‍♀️", facepalm: "🤦", shrug: "🤷", saluting_face: "🫡", handshake: "🤝", writing_hand: "✍️", hugging_face: "🤗", sleeping: "😴", money_mouth_face: "🤑", hushed: "😯", disappointed: "😞", slightly_frowning_face: "🙁", innocent: "😇", smirk: "😏", stuck_out_tongue: "😛", yum: "😋", crossed_fingers: "🤞", v: "✌️", raised_hand: "✋", heavy_exclamation_mark: "❗", no_entry: "⛔", construction: "🚧", new: "🆕", soon: "🔜", hourglass_flowing_sand: "⏳", spiral_calendar_pad: "🗓️", speech_balloon: "💬", thought_balloon: "💭", loudspeaker: "📢", mega: "📣", bell: "🔔", globe_with_meridians: "🌐", house: "🏠", office: "🏢", package: "📦", gift: "🎁", balloon: "🎈", confetti_ball: "🎊" };
  const emo = (t) => String(t).replace(/:([a-z0-9_+\-]+)(?:::skin-tone-\d)?:/g, (m, k) => EMOJI[k] || m);
  // A Slack message (its raw text) as HTML. names: { U123: "Name" } for <@U123>.
  function render(raw, names) {
    names = names || {};
    const toks = [];
    const keep = (html) => "\u0001" + (toks.push(html) - 1) + "\u0002";
    let t = String(raw || "");
    t = t.replace(/<(https?:\/\/[^|>\s]+)(?:\|([^>]+))?>/g, (m, u, l) => keep('<a href="' + esc(u) + '" target="_blank" rel="noopener">' + esc(emo(l || u)) + "</a>"))
      .replace(/<(mailto|tel):([^|>]+)(?:\|([^>]+))?>/g, (m, k, u, l) => keep('<a href="' + k + ":" + esc(u) + '">' + esc(l || u) + "</a>"))
      .replace(/<@([UW][A-Z0-9]+)(?:\|([^>]+))?>/g, (m, id, n) => keep('<span class="sk-at">@' + esc(n || names[id] || "someone") + "</span>"))
      .replace(/<#C[A-Z0-9]+\|([^>]*)>/g, (m, n) => keep('<span class="sk-at">#' + esc(n) + "</span>"))
      .replace(/<!(channel|here|everyone)[^>]*>/g, (m, n) => keep('<span class="sk-at">@' + n + "</span>"))
      .replace(/<!subteam\^[A-Z0-9]+(?:\|([^>]+))?>/g, (m, n) => keep('<span class="sk-at">' + esc(n || "@group") + "</span>"));
    t = t.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
    let h = esc(emo(t));
    // Bare addresses (no <> around them) also open.
    h = h.replace(/(^|[\s(])((?:https?:\/\/|www\.)[^\s<]+[^\s<.,;:!?)\]'"])/g, (m, pre, u) => pre + keep('<a href="' + (u.startsWith("www.") ? "https://" + u : u) + '" target="_blank" rel="noopener">' + u + "</a>"));
    h = h.replace(/```([\s\S]+?)```/g, (m, c) => keep("<pre>" + c + "</pre>"))
      .replace(/`([^`\n]+)`/g, (m, c) => keep("<code>" + c + "</code>"))
      .replace(/(^|[\s(])\*([^*\n]+)\*(?=$|[\s).,;:!?])/g, "$1<b>$2</b>")
      .replace(/(^|[\s(])_([^_\n]+)_(?=$|[\s).,;:!?])/g, "$1<i>$2</i>")
      .replace(/(^|[\s(])~([^~\n]+)~(?=$|[\s).,;:!?])/g, "$1<s>$2</s>")
      .replace(/^&gt; ?(.*)$/gm, '<span class="sk-quote">$1</span>')
      .replace(/\n/g, "<br>");
    return h.replace(/\u0001(\d+)\u0002/g, (m, i) => toks[Number(i)]);
  }
  // Pasted text (an AI answer in Markdown, or rich HTML) in Slack's format.
  function toSlack(md) {
    // Bold is parked first (\u0003…\u0004) so the single-* italics step can't take it.
    return String(md || "")
      .replace(/\r\n/g, "\n")
      .replace(/^#{1,6}\s+(.+)$/gm, "\u0003$1\u0004")
      .replace(/\*\*(.+?)\*\*/g, "\u0003$1\u0004").replace(/__(.+?)__/g, "\u0003$1\u0004")
      .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, (m, p, x) => p + "_" + x + "_")
      .replace(/\u0003/g, "*").replace(/\u0004/g, "*")
      .replace(/~~(.+?)~~/g, "~$1~")
      .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, "<$2|$1>")
      .replace(/^\s*[-*+]\s+/gm, "• ")
      .replace(/^(\s*)(\d+)\.\s+/gm, "$1$2. ")
      .replace(/\n{3,}/g, "\n\n").trim();
  }
  function htmlToSlack(html) {
    const d = document.createElement("div");
    d.innerHTML = html;
    d.querySelectorAll("script,style").forEach((x) => x.remove());
    const walk = (n) => {
      if (n.nodeType === 3) return n.textContent;
      const kids = [...n.childNodes].map(walk).join("");
      switch ((n.tagName || "").toLowerCase()) {
        case "b": case "strong": return kids.trim() ? "*" + kids.trim() + "*" : "";
        case "i": case "em": return kids.trim() ? "_" + kids.trim() + "_" : "";
        case "s": case "del": case "strike": return "~" + kids + "~";
        case "code": return "`" + kids + "`";
        case "pre": return "```" + n.textContent + "```\n";
        case "a": return n.getAttribute("href") && /^https?:/.test(n.getAttribute("href")) ? "<" + n.getAttribute("href") + "|" + kids + ">" : kids;
        case "br": return "\n";
        case "li": return "• " + kids.trim() + "\n";
        case "p": case "div": case "ul": case "ol": return kids + "\n";
        case "h1": case "h2": case "h3": case "h4": return "*" + kids.trim() + "*\n";
        default: return kids;
      }
    };
    return walk(d).replace(/\n{3,}/g, "\n\n").trim();
  }
  let users = null;
  const loadUsers = () => users ? Promise.resolve(users) : new Promise((res) => { try { chrome.runtime.sendMessage({ type: "SLACK_USERS" }, (r) => { void chrome.runtime.lastError; users = (r && r.list) || []; res(users); }); } catch (e) { res([]); } });
  const PICK = ["👍", "🙏", "✅", "👀", "🎉", "🔥", "😊", "😄", "😂", "🙌", "👏", "💯", "❤️", "🤝", "🚀", "⚠️", "❗", "❓", "💡", "📌", "📈", "⏰", "🤔", "😅", "😬", "🫡", "✔️", "❌"];
  // A textarea made into a Slack reply box. Returns { value() } - the text to send,
  // with chosen @people as real mentions.
  function composer(ta) {
    const box = ta.parentNode, picked = new Map(); // "@Name" -> U123
    const bar = document.createElement("div");
    bar.className = "sk-cbar";
    bar.innerHTML = '<button type="button" class="sk-cb" data-c="at" title="Mention someone (or type @)">@</button><button type="button" class="sk-cb" data-c="emo" title="Emoji">😊</button><button type="button" class="sk-cb" data-c="b" title="Bold"><b>B</b></button><button type="button" class="sk-cb" data-c="i" title="Italic"><i>I</i></button><button type="button" class="sk-cb" data-c="link" title="Link">🔗</button><span class="sk-chint">Paste from an AI chat keeps its bold, lists and links.</span>';
    ta.after(bar);
    const pop = document.createElement("div");
    pop.className = "sk-pop"; pop.hidden = true;
    bar.after(pop);
    const insert = (s) => { const a = ta.selectionStart, b = ta.selectionEnd; ta.value = ta.value.slice(0, a) + s + ta.value.slice(b); ta.selectionStart = ta.selectionEnd = a + s.length; ta.focus(); };
    const wrap = (l, r) => { const a = ta.selectionStart, b = ta.selectionEnd, sel = ta.value.slice(a, b) || "text"; ta.value = ta.value.slice(0, a) + l + sel + r + ta.value.slice(b); ta.selectionStart = a + l.length; ta.selectionEnd = a + l.length + sel.length; ta.focus(); };
    const showPeople = async (q) => {
      const list = (await loadUsers()).filter((u) => !q || (u.name + " " + u.handle).toLowerCase().includes(q.toLowerCase())).slice(0, 8);
      if (!list.length) { pop.hidden = true; return; }
      pop.innerHTML = list.map((u, i) => '<button type="button" class="sk-pp' + (i === 0 ? " on" : "") + '" data-id="' + esc(u.id) + '" data-n="' + esc(u.name || u.handle) + '">' + esc(u.name || u.handle) + (u.handle ? ' <span class="hint">@' + esc(u.handle) + "</span>" : "") + "</button>").join("");
      pop.hidden = false; pop.dataset.mode = "at";
      pop.querySelectorAll(".sk-pp").forEach((b) => { b.onmousedown = (e) => { e.preventDefault(); choose(b.dataset.id, b.dataset.n); }; });
    };
    const choose = (id, n) => {
      const a = ta.selectionStart, before = ta.value.slice(0, a), at = before.lastIndexOf("@");
      const start = at >= 0 && !/\s/.test(before.slice(at + 1)) ? at : a;
      const tag = "@" + n;
      ta.value = ta.value.slice(0, start) + tag + " " + ta.value.slice(a);
      ta.selectionStart = ta.selectionEnd = start + tag.length + 1;
      picked.set(tag, id);
      pop.hidden = true; ta.focus();
    };
    bar.querySelectorAll("[data-c]").forEach((b) => {
      b.onclick = () => {
        const c = b.dataset.c;
        if (c === "at") { insert("@"); showPeople(""); return; }
        if (c === "b") return wrap("*", "*");
        if (c === "i") return wrap("_", "_");
        if (c === "link") { const u = prompt("Link address (https://…)"); if (u && /^https?:\/\//.test(u)) { const a = ta.selectionStart, b2 = ta.selectionEnd, l = ta.value.slice(a, b2) || u; ta.value = ta.value.slice(0, a) + "<" + u + "|" + l + ">" + ta.value.slice(b2); } return; }
        if (c === "emo") {
          if (!pop.hidden && pop.dataset.mode === "emo") { pop.hidden = true; return; }
          pop.innerHTML = PICK.map((e) => '<button type="button" class="sk-em">' + e + "</button>").join("");
          pop.hidden = false; pop.dataset.mode = "emo";
          pop.querySelectorAll(".sk-em").forEach((x) => { x.onclick = () => { insert(x.textContent); }; });
        }
      };
    });
    ta.addEventListener("input", () => {
      const before = ta.value.slice(0, ta.selectionStart), m = before.match(/(^|\s)@([^\s@]{0,30})$/);
      if (m) showPeople(m[2]); else if (pop.dataset.mode === "at") pop.hidden = true;
    });
    ta.addEventListener("keydown", (e) => {
      if (pop.hidden || pop.dataset.mode !== "at") return;
      const opts = [...pop.querySelectorAll(".sk-pp")], i = opts.findIndex((x) => x.classList.contains("on"));
      if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); const j = (i + (e.key === "ArrowDown" ? 1 : -1) + opts.length) % opts.length; opts.forEach((x, k) => x.classList.toggle("on", k === j)); }
      else if ((e.key === "Enter" || e.key === "Tab") && opts[i]) { e.preventDefault(); choose(opts[i].dataset.id, opts[i].dataset.n); }
      else if (e.key === "Escape") pop.hidden = true;
    });
    ta.addEventListener("paste", (e) => {
      const dt = e.clipboardData;
      if (!dt) return;
      const html = dt.getData("text/html"), txt = dt.getData("text/plain");
      const out = html ? htmlToSlack(html) : /(\*\*|^#{1,6}\s|\[[^\]]+\]\(https?:|^\s*[-*+]\s)/m.test(txt) ? toSlack(txt) : null;
      if (out == null) return;
      e.preventDefault();
      insert(out);
    });
    box.addEventListener("focusout", () => setTimeout(() => { if (!box.contains(document.activeElement)) pop.hidden = true; }, 150));
    return {
      value() {
        let v = ta.value;
        for (const [tag, id] of picked) v = v.split(tag).join("<@" + id + ">");
        return v;
      },
    };
  }
  window.PcmSlackUi = { render, toSlack, htmlToSlack, composer, emo };
  try { if (typeof renderSlackTab === "function") renderSlackTab(); } catch (e) {} // drawn plain before this file loaded
})();
