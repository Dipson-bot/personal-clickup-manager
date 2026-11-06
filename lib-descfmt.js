// The closing fields every task description carries, and whether they are
// filled in properly (Insights > Descriptions). Two formats are allowed:
//   Format 1: Client Description, Pre Description, Pre File, Description, File
//   Format 2: Pre Description, Pre File, Description, File
// each written as  Label: "value". File must hold only links, separated by
// commas: File: "a.com,b.com" or File: "a.com","b.com".
// Loaded as a plain script (options page) and as a side-effect import
// (background); it only sets globalThis.PcmDescFmt.
(function (g) {
  "use strict";
  const LABELS = ["Client Description", "Pre Description", "Pre File", "Checklist File", "Description", "File"];
  const FORMAT1 = ["Client Description", "Pre Description", "Pre File", "Description", "File"];
  const FORMAT2 = ["Pre Description", "Pre File", "Description", "File"];
  const KEY = { "Client Description": "clientDescription", "Pre Description": "preDescription", "Pre File": "preFile", "Checklist File": "checklistFile", "Description": "description", "File": "file" };
  const Q_OPEN = /^["“”„]/;
  const Q_CLOSE = /["“”]$/;
  // A label line: optional list/quote/heading marks and bold, the label, a colon.
  const LABEL_RE = new RegExp("^[ \\t>*_#-]*(?:\\*\\*|__)?\\s*(" + LABELS.map((l) => l.replace(/ /g, "\\s+")).join("|") + ")\\s*(?:\\*\\*|__)?\\s*:\\s*(?:\\*\\*|__)?", "i");
  const canon = (s) => LABELS.find((l) => l.toLowerCase() === String(s).replace(/\s+/g, " ").toLowerCase()) || s;
  const unescape = (s) => String(s || "").replace(/\\([\\`*_{}\[\]()#+\-.!~|>"])/g, "$1");

  // Every label line of the description, in order: { label, start, end, valueStart }.
  // A field's text runs from after its colon to the next label line (or the end);
  // a quoted value stops at its closing quote.
  function fieldsOf(text) {
    const src = String(text || "").replace(/\r\n?/g, "\n");
    const lines = [];
    let pos = 0;
    for (const line of src.split("\n")) {
      const m = LABEL_RE.exec(line);
      if (m) lines.push({ label: canon(m[1]), start: pos, valueStart: pos + m[0].length });
      pos += line.length + 1;
    }
    for (let i = 0; i < lines.length; i++) lines[i].end = i + 1 < lines.length ? lines[i + 1].start : src.length;
    return { src, lines };
  }
  // Where a field's value sits inside its segment: a quoted value runs from its
  // opening quote to the first quote that ends a line ("a.com","b.com" stays one
  // value, and a value over several lines ends where its last line closes), so
  // any notes written below it are not part of it. Unquoted = the whole segment.
  function spanOf(seg) {
    seg = String(seg || "");
    const lead = /^[ \t]*(?:\*\*|__)?[ \t]*/.exec(seg)[0].length;
    if (!Q_OPEN.test(seg.charAt(lead))) {
      const body = seg.slice(lead).replace(/\s+$/, "").replace(/\s*(?:\*\*|__)$/, "");
      return { from: lead, to: lead + body.length, inner: body, quoted: false };
    }
    const re = /["“”](?:\*\*|__)?[ \t]*(?=\n|$)/g;
    re.lastIndex = lead + 1;
    const m = re.exec(seg);
    const close = m ? m.index : -1;
    if (close < 0) return { from: lead, to: seg.replace(/\s+$/, "").length, inner: seg.slice(lead + 1).replace(/\s+$/, ""), quoted: true };
    return { from: lead, to: m.index + m[0].replace(/[ \t]+$/, "").length, inner: seg.slice(lead + 1, close), quoted: true };
  }
  // The text inside the quotes (or the bare text when unquoted), markdown escapes undone.
  function valueOf(seg) {
    const sp = spanOf(seg);
    return { raw: unescape(sp.inner).trim(), quoted: sp.quoted };
  }

  // Links in a piece of text: plain addresses, bare domains (abc.com) and
  // markdown links [text](url). Each once, in order.
  const URL_RE = /\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)|<(https?:\/\/[^>\s]+)>|\bhttps?:\/\/[^\s"“”<>,)\]]+|\b(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/[^\s"“”<>,)\]]*)?/gi;
  function linksIn(text) {
    const out = [];
    const add = (u) => { u = String(u || "").replace(/[.;:!?]+$/, ""); if (u && !out.includes(u)) out.push(u); };
    const s = unescape(text);
    let m;
    URL_RE.lastIndex = 0;
    while ((m = URL_RE.exec(s))) {
      if (m[2]) add(m[2]);
      else if (m[3]) add(m[3]);
      else if (/^https?:/i.test(m[0])) add(m[0]);
      else if (/\.[a-z]{2,}(\/|$)/i.test(m[0]) && !/\.(png|jpe?g|gif|pdf|docx?|xlsx?|csv|txt)$/i.test(m[0]) && !/@/.test(s.slice(Math.max(0, m.index - 1), m.index))) add(m[0]);
    }
    return out;
  }
  // One token of a File value is a link and nothing else.
  const LINK_TOKEN = /^(?:https?:\/\/)?(?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d+)?(?:[/?#]\S*)?$/i;
  function tokenLink(t) {
    t = String(t || "").trim();
    let m = /^\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)$/.exec(t);
    if (m) return m[1].trim() === m[2] || m[1].trim() === m[2].replace(/^https?:\/\//, "") ? m[2] : ""; // [text](url): text must be the link itself
    m = /^<(https?:\/\/[^>\s]+)>$/.exec(t);
    if (m) return m[1];
    return LINK_TOKEN.test(t) ? t : "";
  }
  // File value: "ok" (only links, comma separated), "empty" or "bad".
  function fileState(raw) {
    const s = String(raw || "").trim();
    if (!s) return "empty";
    if (/\n/.test(s)) return "bad";
    const parts = s.split(/["“”]?\s*,\s*["“”]?/);
    if (!parts.length || parts.some((p) => !tokenLink(p))) return "bad";
    return "ok";
  }

  // The verdict for one description:
  // { format: 1 | 2 | 0, values: { description, file, ... }, present: [labels],
  //   problems: ["notFormatted" | "missingClientDescription" | "missingDescription" | "missingFile" | "fileNotFormatted"] }
  // opts.pre: also report empty Pre Description / Pre File ("missingPreDescription",
  // "missingPreFile") - Insights > Descriptions lets the user switch those checks on.
  function check(text, opts) {
    const { src, lines } = fieldsOf(text);
    const values = {};
    const present = [];
    for (const l of lines) {
      if (present.includes(l.label)) continue; // the first one counts
      present.push(l.label);
      values[KEY[l.label]] = valueOf(src.slice(l.valueStart, l.end)).raw;
    }
    const has = (l) => present.includes(l);
    const core = ["Client Description", "Pre Description", "Pre File", "Description", "File"].some(has);
    const problems = [];
    let format = 0;
    if (!core) problems.push("notFormatted");
    else {
      format = has("Client Description") ? 1 : 2;
      // Some of the format's lines are there, not all: the fix adds the missing ones.
      if (["Pre Description", "Pre File", "Description", "File"].some((l) => !has(l))) problems.push("incompleteFormat");
      if (format === 1 && !values.clientDescription) problems.push("missingClientDescription");
      if (!values.description) problems.push("missingDescription");
      const fs = fileState(values.file);
      if (fs === "empty") problems.push("missingFile");
      else if (fs === "bad") problems.push("fileNotFormatted");
      if (opts && opts.pre) {
        if (!values.preDescription) problems.push("missingPreDescription");
        if (!values.preFile) problems.push("missingPreFile");
      }
    }
    return { format, values, present, problems };
  }

  const qv = (v) => '"' + String(v == null ? "" : v).replace(/\r\n?/g, "\n").trim() + '"';
  // Links to a strict File value: "a.com,b.com".
  const fileValue = (links) => (links || []).map((u) => String(u).trim()).filter(Boolean).join(",");

  // Write values into the description. set = { "Description": "...", "File": "..." }
  // (labels as keys). A field that is there gets its value replaced inside the
  // quotes; a missing field is added after the last field of the format; with
  // no format at all, addFormat (1 or 2) adds the whole block at the end.
  function apply(text, set, addFormat) {
    let { src, lines } = fieldsOf(text);
    const want = Object.assign({}, set || {});
    const order = check(src).format === 1 || addFormat === 1 ? FORMAT1 : FORMAT2;
    const core = lines.some((l) => order.includes(l.label) || l.label === "Client Description");
    if (!core) {
      // No format yet: the whole description goes INTO the format, nothing is
      // left outside it. Its text is the task's brief -> Pre Description; the
      // link-only lines at its end -> File.
      const fmt = addFormat === 1 ? FORMAT1 : FORMAT2;
      const rows = src.replace(/\s+$/, "").split("\n");
      const links = [];
      while (rows.length) {
        const last = rows[rows.length - 1].trim();
        if (!last) { rows.pop(); continue; }
        const ls = linksIn(last);
        // A line of links only (nothing left once they are taken out).
        const rest = ls.reduce((x, u) => x.split(u).join(" "), last).replace(/[\[\]()<>,;\s]+/g, "");
        if (ls.length && !rest) { links.unshift(...ls); rows.pop(); continue; }
        break;
      }
      // Double quotes inside would close the field early: single ones instead.
      const body = rows.join("\n").replace(/["“”]/g, "'").trim();
      if (body) want["Pre Description"] = body; // the task's own words win over any suggestion
      // The links go into File (Pre File is optional - the team's rule), next to any
      // links the fix already put there, each once.
      if (links.length) want["File"] = fileValue([...new Set(linksIn(String(want["File"] || "")).concat(links))]);
      return fmt.map((l) => l + ": " + qv(want[l] || "")).join("\n\n");
    }
    // Replace from the end so earlier offsets stay right; only the first of each label.
    const seen = new Set();
    const firsts = lines.filter((l) => !seen.has(l.label) && seen.add(l.label));
    for (const l of firsts.slice().sort((a, b) => b.start - a.start)) {
      if (!(l.label in want)) continue;
      const seg = src.slice(l.valueStart, l.end);
      // Only the value is replaced; anything written after it stays.
      const sp = spanOf(seg);
      const before = src.slice(0, l.valueStart).replace(/[ \t]+$/, "");
      src = before + " " + qv(want[l.label]) + src.slice(l.valueStart + sp.to);
      delete want[l.label];
    }
    // Fields still missing go in where the format puts them.
    for (const label of order) {
      if (!(label in want)) continue;
      const cur = fieldsOf(src).lines;
      const idx = order.indexOf(label);
      const after = cur.filter((l) => order.indexOf(l.label) >= 0 && order.indexOf(l.label) < idx).pop();
      const before = cur.find((l) => order.indexOf(l.label) > idx);
      const line = label + ": " + qv(want[label]);
      if (after) {
        const at = after.end;
        const head = src.slice(0, at).replace(/\s+$/, "");
        const tail = src.slice(at).replace(/^\s+/, "");
        src = head + "\n\n" + line + (tail ? "\n\n" + tail : "\n");
      } else if (before) {
        src = src.slice(0, before.start) + line + "\n\n" + src.slice(before.start);
      } else src = src.replace(/\s+$/, "") + "\n\n" + line;
      delete want[label];
    }
    return src;
  }

  const PROBLEM_LABEL = {
    notFormatted: "Not formatted",
    incompleteFormat: "Incomplete format",
    missingClientDescription: "Missing client description",
    missingDescription: "Missing description",
    missingFile: "Missing file",
    fileNotFormatted: "File not formatted",
    missingPreDescription: "Missing pre description",
    missingPreFile: "Missing pre file",
  };
  // A short fingerprint of a description (FNV-1a), so a fix prepared earlier is
  // only reused while the task still reads exactly the same.
  function hash(text) {
    const s = String(text || "").replace(/\r\n?/g, "\n").trim();
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return h.toString(16) + ":" + s.length;
  }
  g.PcmDescFmt = { hash, check, apply, linksIn, fileState, fileValue, PROBLEM_LABEL, FORMAT1, FORMAT2 };
})(globalThis);
