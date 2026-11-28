// Site monitor › a client's page › 📄 Export report: the monthly client report as Word
// files, with NO choices: each client follows its recipe (Admin › Team hub › Report
// recipes - kept in the team hub, never in this code). One click -> the client file
// (positive only) + an internal file (every number, the reasoning, unedited screenshots).
// Screenshots are real captures from the source tool, taken in the recipe's Chrome profile;
// never a drawn panel. Uses the bundled docx library (vendor/docx.iife.js, window.docx).
// Owner's spec 2026-11-29 (Client_Report_Recipes). Formats so far: "ga-organic".
(function () {
  "use strict";
  const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const ymAdd = (ym, n) => { const [y, m] = ym.split("-").map(Number), t = y * 12 + (m - 1) + n; return Math.floor(t / 12) + "-" + String((t % 12) + 1).padStart(2, "0"); };
  const monthName = (ym) => MONTHS[Number(ym.slice(5)) - 1];
  const daysIn = (ym) => new Date(Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5)), 0)).getUTCDate();
  const rangeText = (ym) => ABBR[Number(ym.slice(5)) - 1] + " 1–" + daysIn(ym) + ", " + ym.slice(0, 4);
  const fullMonths = (s) => String(s).replace(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b/g, (a) => MONTHS[ABBR.indexOf(a)]);
  const hostOf = (u) => { try { return new URL(/^https?:/i.test(u) ? u : "https://" + u).hostname.replace(/^www\./, "").toLowerCase(); } catch (e) { return String(u || "").toLowerCase(); } };
  const lastComplete = () => ymAdd(new Date().toISOString().slice(0, 7), -1);
  // Client-facing words that must never reach the client (owner's list); word-start matching so "both" / "latest" pass.
  const BANNED = /\b(exclud\w*|duplicates?|counted once|twice|tests?|testing|spam\w*|flag\w*|filter\w*|removed|not counted|not shown|bots?|fraud\w*|internal|non-lead\w*|reviewed individually)\b/i;
  const FORMATS = { "ga-organic": "GA organic leads report" };

  // The recipe for a site: matched by domain. Recipes marked hidden / skip / discontinued never export.
  function recipeFor(recipes, siteUrl) {
    const h = hostOf(siteUrl);
    return (recipes || []).find((r) => r && r.domain && hostOf(r.domain) === h) || null;
  }
  // Delivered totals win over live numbers for past months, so "rose from N" always matches
  // what the client was sent (recipe history seeds them; each export adds the new month).
  function withDelivered(data, recipe, delivered) {
    const hist = { ...((recipe && recipe.history) || {}) };
    for (const [ym, v] of Object.entries((delivered && recipe && delivered[recipe.key]) || {})) hist[ym] = v && typeof v === "object" ? v.total : v;
    const ga = { ...(data.ga || {}) };
    for (const [ym, total] of Object.entries(hist)) if (ga[ym] && Number.isFinite(Number(total))) ga[ym] = { ...ga[ym], leadsOrg: Number(total) };
    return { ...data, ga, history: hist };
  }

  // ---- What goes in the report for month ym ----
  function build(recipe, data, ym) {
    const SD = window.PcmSiteDetail;
    const w = SD.clientWins(data, ymAdd(ym, 1) + "-01"); // the report month is the "last complete month"
    const g = (data.ga || {})[ym] || null;
    const leads = g ? g.leadsOrg || 0 : 0;
    const sources = Object.entries((g && g.srcOrg) || {}).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
    const head = w.pick && w.pick.headline ? w.pick.wins[0] : null;
    const comparison = head ? fullMonths(head.text) + "." : "";
    const fill = (t) => String(t || "").replace(/<Month>|\{Month\}/g, monthName(ym));
    return { w, leads, sources, comparison, ym, recipe,
      title: fill(recipe.title || "Organic Leads (<Month>)"),
      caption: "Google Analytics > Events: generate_lead by session source / medium, " + rangeText(ym) + ".",
      intro: recipe.intro || "Leads from the website are tracked in Google Analytics. The organic leads for the month, from people who found the website through search engines, are listed below.",
      note: String(recipe.note || "").trim(),
      tally: "Organic leads: " + leads.toLocaleString(),
      nothing: !head && leads === 0 }; // this format prints organic leads only, so supporting-metric wins don't count
  }
  // ---- Client-facing checks ----
  function check(r) {
    const paras = [r.title, r.caption, r.intro, "Note:"].concat(r.note ? r.note.split(/\n\s*\n/) : [], r.comparison ? [r.comparison] : [], r.sources.flatMap(([s, n]) => [s, String(n)]), [r.tally]);
    const problems = [];
    for (const p of paras) {
      const m = BANNED.exec(p);
      if (m) problems.push('"' + m[0] + '" in: ' + p.slice(0, 90));
      if (p.includes("%")) problems.push('"%" in: ' + p.slice(0, 90) + " (use counts, old → new)");
      if ((p.match(/\$/g) || []).length > 1) problems.push('two "$" in one paragraph: ' + p.slice(0, 90) + " (write USD for the second amount)");
      if (/(^|[^\w])-\s?\d/.test(p.replace(/\d{4}-\d{2}/g, ""))) problems.push("a negative number in: " + p.slice(0, 90));
    }
    return problems;
  }

  // ---- The Word documents (client + internal) ----
  async function docxBlob(r, shots, internal) {
    const D = window.docx;
    const run = (text, o) => new D.TextRun({ text, font: "Lexend", color: "000000", size: 22, ...(o || {}) });
    const para = (text, o, po) => new D.Paragraph({ children: [run(text, o)], spacing: { after: 160 }, ...(po || {}) });
    const B = (color) => ({ style: D.BorderStyle.SINGLE, size: 4, color });
    const borders = { top: B("bfbfbf"), left: B("d9d9d9"), bottom: B("d9d9d9"), right: B("d9d9d9") };
    const cell = (text, w, header) => new D.TableCell({ width: { size: w, type: D.WidthType.DXA }, borders,
      ...(header ? { shading: { type: D.ShadingType.CLEAR, color: "auto", fill: "1f3864" } } : {}),
      margins: { top: 60, bottom: 60, left: 100, right: 100 },
      children: [new D.Paragraph({ children: [run(String(text), { bold: true, size: 18, color: header ? "FFFFFF" : "000000" })] })] });
    const table = (widths, head, body) => new D.Table({ layout: D.TableLayoutType.FIXED, columnWidths: widths, width: { size: 9356, type: D.WidthType.DXA },
      rows: [new D.TableRow({ tableHeader: true, children: head.map((h, i) => cell(h, widths[i], true)) })].concat(body.map((row) => new D.TableRow({ cantSplit: true, children: row.map((t, i) => cell(t, widths[i], false)) }))) });
    const image = (s) => new D.Paragraph({ children: [new D.ImageRun({ type: "png", data: s.bytes, transformation: { width: 624, height: Math.round((624 * s.h) / s.w) } })], spacing: { after: 80 } });
    // Title: Lexend bold black 20 pt (no Word heading colour or serif).
    const h1 = (text) => new D.Paragraph({ heading: D.HeadingLevel.HEADING_1, children: [run(text, { bold: true, size: 40, color: "000000" })], spacing: { after: 200 } });
    const h2 = (text) => new D.Paragraph({ heading: D.HeadingLevel.HEADING_2, children: [run(text, { bold: true, size: 28, color: "000000" })], spacing: { before: 240, after: 120 } });
    const kids = [];
    kids.push(h1((internal ? "INTERNAL — do not send: " : "") + r.title));
    kids.push(image(shots.client));
    kids.push(para(r.caption, { italics: true, size: 18 }));
    kids.push(para(r.intro));
    if (r.note) { kids.push(para("Note:", { bold: true }, { spacing: { after: 60 } })); r.note.split(/\n\s*\n/).slice(0, 2).forEach((t) => kids.push(para(t.replace(/\s*\n\s*/g, " ")))); }
    if (r.comparison) kids.push(para(r.comparison, { bold: true }));
    if (r.sources.length) { kids.push(table([6356, 3000], ["Source", "Organic leads"], r.sources.map(([s, n]) => [s, n.toLocaleString()]))); kids.push(para("")); }
    kids.push(para(r.tally, { bold: true }));
    if (internal) {
      const SDm = ["leadsOrg", "leadsAll", "orgSessions", "orgViews", "clicks", "imp", "pos", "ctr", "keyEvents"], lab = { leadsOrg: "Organic leads", leadsAll: "Leads (all)", orgSessions: "Organic visits", orgViews: "Organic page views", clicks: "Clicks", imp: "Impressions", pos: "Avg position", ctr: "CTR", keyEvents: "Key events" };
      const fmt = (k, v) => (k === "pos" ? v.toFixed(1) : k === "ctr" ? v.toFixed(2) + "%" : Math.round(v).toLocaleString());
      const cellTxt = (k, q) => (q.st === "nodata" ? "no data" : fmt(k, q.a) + " → " + fmt(k, q.b) + " " + (q.st === "up" ? "▲" : q.st === "down" ? "▼" : "="));
      kids.push(h2("Internal check"));
      kids.push(para("Recipe: " + r.recipe.name + " · format " + (FORMATS[r.recipe.format] || r.recipe.format) + " · Chrome profile " + (r.recipe.profile || "-") + " · GA property " + (r.recipe.ga || "-") + "."));
      r.w.notes.forEach((n) => kids.push(para(n)));
      const hist = Object.entries(r.history || {}).sort().map(([k, v]) => monthName(k) + " " + k.slice(0, 4) + ": " + v).join(" · ");
      if (hist) kids.push(para("Delivered totals used for past months: " + hist + "."));
      const P = r.w.periods, heads = ["Metric"].concat(P.tiers.flatMap((t) => [t.label + " vs prev", t.label + " vs last year"]));
      kids.push(table([2156, 1200, 1200, 1200, 1200, 1200, 1200], heads, SDm.map((k) => [lab[k]].concat(P.tiers.flatMap((t) => [cellTxt(k, r.w.grid[k][t.key].prev), cellTxt(k, r.w.grid[k][t.key].yoy)])))));
      if (r.allSources && r.allSources.length) { kids.push(para("")); kids.push(table([6356, 3000], ["Every source (generate_lead)", "Events"], r.allSources)); }
      if (shots.raw) { kids.push(h2("Unedited screenshot")); kids.push(image(shots.raw)); }
    }
    const doc = new D.Document({ creator: "", title: r.title, styles: { default: { document: { run: { font: "Lexend", size: 22, color: "000000" } }, heading1: { run: { font: "Lexend", size: 40, bold: true, color: "000000" } }, heading2: { run: { font: "Lexend", size: 28, bold: true, color: "000000" } } } },
      sections: [{ properties: { page: { size: { width: 12240, height: 15840 }, margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 } } }, children: kids }] });
    return D.Packer.toBlob(doc);
  }

  // ---- The GA screenshot (background GA_PROOF) ----
  // Taken by the helper copy of the extension in the Chrome profile signed in as the recipe's
  // account (through the ClickUp Tracker app on this computer); with no such helper running,
  // by this profile, if it can see the property.
  const b64Img = (b64, w, h) => { const bin = atob(b64), bytes = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i); const blob = new Blob([bytes], { type: "image/png" }); return { bytes, w, h, blob, url: URL.createObjectURL(blob) }; };
  async function capture(recipe, ym) {
    const pid = (String(recipe.ga || "").match(/p(\d+)$/) || String(recipe.ga || "").match(/(\d{6,})$/) || [])[1];
    if (!pid) return { ok: false, why: "The recipe has no GA4 property (ga: \"a…p…\")." };
    const r = await chrome.runtime.sendMessage({ type: "GA_PROOF", propertyId: pid, ym, account: recipe.profile || "", expect: recipe.profile || "", organicOnly: true }).catch(() => null);
    if (!r || !r.ok) {
      const who = recipe.profile || "an account that can see this client's Analytics";
      const where = r && r.via === "helper" ? "In the " + who + " Chrome profile, " : "Here, ";
      const why = !r ? "The screenshot didn't come back." : r.reason === "helpertimeout" ? r.error : r.reason === "permission" ? where + "Google Analytics showed Missing permissions." : r.reason === "signin" || r.reason === "account" ? where + "Google Analytics isn't signed in as " + who + "." : r.reason === "timeout" ? where + "Google Analytics didn't load within 20 seconds - try again." : "The capture failed" + (r.error ? " (" + r.error + ")" : "") + ".";
      const fix = r && r.via === "helper" ? "" : r && r.helperWhy === "noapp" ? " Start the ClickUp Tracker taskbar app, then export again." : r && r.helperWhy === "oldapp" ? " Update the ClickUp Tracker app, then export again." : recipe.profile ? " Set up the helper once: in the Chrome profile signed in as " + who + ", install this extension, open Site monitor › Helper profile, tick Use this profile as a helper and enter " + who + ". Keep that profile open." : "";
      return { ok: false, why: why + fix };
    }
    return { ok: true, client: b64Img(r.png, r.w, r.h), raw: r.raw ? b64Img(r.raw, r.rawW, r.rawH) : null, as: (r.via === "helper" ? "helper " : "") + (r.account || "") };
  }
  async function keepRaw(recipe, ym, raw) { // unedited capture -> the client's files (internal records)
    try {
      if (!raw || !window.PcmFiles || !window.PcmFiles.add) return false;
      const who = (await window.PcmFiles.resolveClient([recipe.name]).catch(() => "")) || recipe.name;
      await window.PcmFiles.add(who, [new File([raw.blob], "GA capture (unedited) - " + monthName(ym) + " " + ym.slice(0, 4) + " - " + new Date().toISOString().slice(0, 10) + ".png", { type: "image/png" })]);
      return true;
    } catch (e) { return false; }
  }
  function download(blob, name) {
    const url = URL.createObjectURL(blob), a = document.createElement("a");
    a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }

  // ---- The export (one click; the dialog only shows progress and the result) ----
  let box = null;
  function close() { if (box) { box.remove(); box = null; } }
  async function open(c, ymPick) {
    close();
    const ym = ymPick || lastComplete();
    box = document.createElement("div");
    box.className = "rx-back";
    box.innerHTML = '<div class="rx-panel" role="dialog" aria-label="Export report"><div class="rx-head"><div><h3>Export monthly report</h3><span class="hint rx-sub"></span></div><button type="button" class="rx-x" title="Close">✕</button></div>' +
      '<div class="rx-body"><div class="rx-steps"></div><div class="rx-preview"><div class="rx-img" hidden></div><div class="rx-sum"></div></div></div>' +
      '<div class="rx-foot"><span class="hint rx-msg"></span><a href="#" class="rx-month">Change month</a><select class="rx-monthsel" hidden></select><button type="button" class="rx-cancel">Close</button></div></div>';
    document.body.appendChild(box);
    const $ = (s) => box.querySelector(s), msg = (t) => { if (box) $(".rx-msg").textContent = t || ""; };
    $(".rx-x").onclick = close; $(".rx-cancel").onclick = close;
    box.addEventListener("mousedown", (e) => { if (e.target === box) close(); });
    const sel = $(".rx-monthsel");
    sel.innerHTML = Array.from({ length: 13 }, (_, i) => ymAdd(new Date().toISOString().slice(0, 7), -i - 1)).map((m) => '<option value="' + m + '"' + (m === ym ? " selected" : "") + ">" + monthName(m) + " " + m.slice(0, 4) + "</option>").join("");
    $(".rx-month").onclick = (e) => { e.preventDefault(); sel.hidden = false; $(".rx-month").hidden = true; };
    sel.onchange = () => open(c, sel.value);
    const steps = [], step = (label) => { const i = steps.push({ label, st: "run" }) - 1; paintSteps(); return (st, extra) => { steps[i].st = st; if (extra) steps[i].label += " - " + extra; paintSteps(); }; };
    const paintSteps = () => { if (box) $(".rx-steps").innerHTML = steps.map((s) => '<div class="rx-step ' + s.st + '"><span>' + (s.st === "run" ? '<i class="sm-spin"></i>' : s.st === "ok" ? "✓" : s.st === "skip" ? "–" : "✕") + "</span>" + esc(s.label) + "</div>").join(""); };
    const stop = (text) => { msg(""); if (box) $(".rx-sum").innerHTML = '<div class="rx-stop">' + esc(text) + "</div>"; };

    // 1. The recipe
    let s = step("Client recipe");
    const rec = await chrome.runtime.sendMessage({ type: "RECIPES_GET" }).catch(() => null);
    if (!box) return;
    if (!rec || !rec.ok) { s("bad"); return stop("Couldn't read the report recipes from the team hub: " + ((rec && rec.error) || "no answer") + "."); }
    const recipe = recipeFor(rec.recipes, c.site.url);
    if (!recipe) { s("bad"); return stop("No report recipe for " + hostOf(c.site.url) + " yet. An admin adds it in Admin › Team hub › Report recipes."); }
    $(".rx-sub").textContent = recipe.name + " · " + monthName(ym) + " " + ym.slice(0, 4) + (ymPick ? "" : " (last complete month)");
    if (recipe.hidden || /^(skip|none|discontinued|paused)$/i.test(recipe.format)) { s("skip", recipe.name); return stop(recipe.name + " has no monthly export (" + (recipe.reason || recipe.format) + ")."); }
    if (!FORMATS[recipe.format]) { s("skip", recipe.name); return stop(recipe.name + "'s report format (" + recipe.format + ") isn't in the extension yet - it comes in a later update."); }
    s("ok", recipe.name + " · " + FORMATS[recipe.format]);
    // 3. The month's numbers (delivered totals win for past months)
    s = step("Google Analytics numbers for " + monthName(ym));
    const from = window.PcmSiteDetail.winPeriods(ymAdd(ym, 1) + "-01").from;
    const pid = (String(recipe.ga || "").match(/p(\d+)$/) || [])[1] || "";
    const raw = await chrome.runtime.sendMessage({ type: "GDATA_MONTHLY", url: c.site.url, from, ga: pid }).catch(() => null);
    if (!box) return;
    if (!raw || !raw.ok || !raw.ga) { s("bad"); return stop("Couldn't read the monthly numbers: " + ((raw && (raw.err || raw.error || (raw.errs || []).join(" · "))) || "no Analytics data") + "."); }
    const data = withDelivered(raw, recipe, rec.delivered);
    const r = build(recipe, data, ym);
    r.history = data.history;
    const g = (raw.ga || {})[ym] || {};
    r.allSources = Object.entries(g.srcOrg || {}).map(([k, n]) => [k, String(n)]);
    s("ok", r.leads + " organic lead" + (r.leads === 1 ? "" : "s") + (r.comparison ? " · a win" : ""));
    // 4. The real screenshot
    s = step("Screenshot from Google Analytics");
    const shot = await capture(recipe, ym);
    if (!box) return;
    if (!shot.ok) { s("bad"); return stop(shot.why); }
    const saved = await keepRaw(recipe, ym, shot.raw);
    s("ok", "organic rows only" + (shot.as ? " · as " + shot.as : "") + (saved ? " · unedited copy saved to the client's files" : ""));
    $(".rx-img").hidden = false; $(".rx-img").innerHTML = '<img alt="Client screenshot" src="' + shot.client.url + '" />';
    $(".rx-sum").innerHTML = "<div><b>" + esc(r.title) + "</b></div>" + (r.comparison ? '<div class="rx-win">▲ ' + esc(r.comparison) + "</div>" : '<div class="hint">No headline win this month - the comparison line is left out.</div>') + "<div>" + esc(r.tally) + "</div>";
    // 5. Checks + files
    s = step("Client-facing checks");
    const clientName = recipe.name.replace(/[\\/:*?"<>|]+/g, "");
    const base = "Monthly Report (" + monthName(ym) + ") - " + clientName;
    const problems = r.nothing ? [] : check(r);
    if (problems.length) s("bad", problems.length + " to fix"); else s(r.nothing ? "skip" : "ok", r.nothing ? "nothing positive" : "passed");
    s = step("Word files");
    try {
      download(await docxBlob(r, shot, true), base + " (internal).docx");
      if (r.nothing) { s("ok", "internal only"); return stop("Nothing positive for " + recipe.name + " in " + monthName(ym) + ". Internal file saved for your lead."); }
      if (problems.length) { s("bad", "internal only"); if (box) $(".rx-sum").insertAdjacentHTML("beforeend", '<div class="rx-problems"><b>Client file not made - fix in the recipe first:</b><ul>' + problems.map((p) => "<li>" + esc(p) + "</li>").join("") + "</ul></div>"); return; }
      download(await docxBlob(r, shot, false), base + ".docx");
      await chrome.runtime.sendMessage({ type: "DELIVERED_SAVE", key: recipe.key, ym, total: r.leads }).catch(() => null);
      s("ok", "client + internal downloaded");
      msg("Saved " + base + ".docx and the internal copy. " + monthName(ym) + "'s total (" + r.leads + ") is recorded for next month's comparison.");
    } catch (e) { s("bad"); stop("Couldn't build the Word files: " + ((e && e.message) || e)); }
  }
  window.PcmReportExport = { open, close, build, check, recipeFor, withDelivered, BANNED, _docx: docxBlob };
})();
