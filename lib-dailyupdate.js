// The Daily Tasks Update text - one builder for the wrap-up page and for the
// scheduled send to Slack (background), so what's sent is what the page shows.
// Every task closed today (any project, subtasks too), grouped by project, each
// with the links from its description as Click Here 1, Click Here 2 ... in
// Slack's <url|label> form. Loaded as a plain script (wrap-up page) and as a
// side-effect import (background); it only sets globalThis.PcmDailyUpdate.
(function (g) {
  "use strict";
  const EXTRA_RE = /^extras?\s+tasks?\b/i;
  const isExtra = (t) => !!t && (t.type === "extra" || EXTRA_RE.test(t.name || ""));
  // "🔥 Acme Plumbing SEO" -> "Acme Plumbing", "NORTH STAR ROOFING SEO" -> "North Star Roofing".
  function projectName(client) {
    let n = String(client || "").replace(/^[^\p{L}\p{N}]+/u, "").replace(/\s+seo\s*$/i, "").trim();
    if (n && n === n.toUpperCase() && /[A-Z]{2}/.test(n)) n = n.toLowerCase().replace(/\b\p{L}/gu, (c) => c.toUpperCase());
    return n || "Other";
  }
  const byName = (a, b) => String(a.name || "").localeCompare(String(b.name || ""), undefined, { numeric: true, sensitivity: "base" });
  function linkPart(links) {
    const l = Array.isArray(links) ? links : [];
    if (!l.length) return "";
    return " : " + (l.length === 1 ? "<" + l[0] + "|Click Here>" : l.map((u, i) => "<" + u + "|Click Here " + (i + 1) + ">").join("  "));
  }
  // rows: the tasks closed today (null = still loading). opts: { error, now }.
  function build(rows, opts) {
    opts = opts || {};
    const when = new Date(opts.now || Date.now());
    const L = ["Daily Tasks Update", "Date: " + when.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" }), ""];
    if (rows === null || rows === undefined) { L.push("Loading the tasks you completed today…"); return L.join("\n"); }
    const list = rows.filter((t) => !isExtra(t));
    if (!list.length) {
      L.push(opts.error ? "Couldn't load today's completed tasks: " + opts.error : "No tasks completed today yet.");
      return L.join("\n");
    }
    const groups = new Map();
    for (const t of list) {
      const p = projectName(t.client);
      if (!groups.has(p)) groups.set(p, []);
      groups.get(p).push(t);
    }
    const order = [...groups.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
    order.forEach(([p, items], i) => {
      if (i) L.push("");
      L.push("Project Name: " + p, "  Complete (" + items.length + ")");
      for (const t of items.slice().sort(byName)) L.push("    · " + t.name + linkPart(t.links));
    });
    return L.join("\n");
  }
  // For Slack's API: the <url|label> links stay links, any other & < > is
  // escaped (Slack's rule), and the leading spaces stay (non-breaking) so the
  // indents look the same as a pasted message.
  const LINK_RE = /<(https?:\/\/[^|>\s]+)\|([^>]+)>/g;
  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  function forSlack(text) {
    return String(text || "").split("\n").map((line) => {
      let out = "", last = 0;
      for (const m of line.matchAll(LINK_RE)) {
        out += esc(line.slice(last, m.index)) + "<" + m[1] + "|" + esc(m[2]).replace(/\|/g, "¦") + ">";
        last = m.index + m[0].length;
      }
      out += esc(line.slice(last));
      return out.replace(/^ +/, (sp) => " ".repeat(sp.length));
    }).join("\n");
  }
  g.PcmDailyUpdate = { build, forSlack, isExtra, projectName };
})(globalThis);
