// Site monitor › click a site: its own page - how it is doing now, its last 30 days
// (uptime, reply time, PageSpeed score, page size), the trend, and what to fix next.
// History comes from background siteHistRecord (storage siteHist), one row a day;
// PageSpeed (mobile + desktop + real-user Core Web Vitals) from storage sitePsi.
// Share copies a plain report; Add to task opens the New task form with the fix filled in.
(function () {
  "use strict";
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const kbTxt = (kb) => (kb >= 1024 ? (kb / 1024).toFixed(1) + " MB" : kb + " KB");
  const msTxt = (ms) => (ms >= 1000 ? (ms / 1000).toFixed(1) + "s" : Math.round(ms) + "ms");
  const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
  const ago = (ts) => { const m = Math.round((Date.now() - Number(ts)) / 60000); return m < 1 ? "just now" : m < 60 ? m + " min ago" : m < 1440 ? Math.round(m / 60) + "h ago" : Math.round(m / 1440) + "d ago"; };
  const siteName = (c) => String((c.site && (c.site.name || c.site.url)) || "").replace(/^\p{Extended_Pictographic}️?\s*/u, "").trim();

  // The days, oldest first, with the numbers each chart needs.
  function series(hist) {
    return (hist || []).slice(-30).map((d) => ({ d: d.d, up: d.n ? (d.up / d.n) * 100 : null, ms: d.msN ? d.ms / d.msN : null, score: d.score != null ? d.score : null, kb: d.kb || null, gz: d.gz || null, dom: d.dom || null }));
  }
  // Last 7 days against the 7 before: "better", "worse" or "steady" for one number.
  function trend(days, key, lowerIsBetter) {
    const v = days.map((d) => d[key]).filter((x) => x != null);
    if (v.length < 6) return null;
    const half = Math.min(7, Math.floor(v.length / 2));
    const a = avg(v.slice(-half)), b = avg(v.slice(-2 * half, -half));
    if (a == null || b == null || !b) return null;
    const ch = (a - b) / Math.abs(b);
    if (Math.abs(ch) < 0.05) return { k: "steady", ch };
    return { k: (ch < 0) === !!lowerIsBetter ? "better" : "worse", ch };
  }
  // A small SVG chart over a fixed 30-day window (so day 1 is one thin bar, not a block).
  function chart(days, key, opt) {
    const W = 300, H = 90, P = 4, N = 30, off = N - days.length, pts = days.map((d, i) => ({ i: i + off, v: d[key], d: d.d }));
    const vals = pts.filter((p) => p.v != null).map((p) => p.v);
    if (!vals.length) return '<div class="sd-empty">No data yet - it fills in day by day as the site is checked.</div>';
    const max = opt.max != null ? opt.max : Math.max(...vals) * 1.15 || 1, min = opt.min != null ? opt.min : 0;
    const slot = (W - 2 * P) / N, x = (i) => P + slot * (i + 0.5), y = (v) => H - P - ((v - min) / (max - min || 1)) * (H - 2 * P);
    let body = "";
    if (opt.bars) {
      const bw = Math.max(2, slot - 2);
      for (const p of pts) if (p.v != null) body += '<rect x="' + (x(p.i) - bw / 2).toFixed(1) + '" y="' + y(p.v).toFixed(1) + '" width="' + bw.toFixed(1) + '" height="' + Math.max(1, H - P - y(p.v)).toFixed(1) + '" rx="1.5" class="' + (p.v < 99 ? "sd-bad" : "sd-ok") + '"><title>' + esc(p.d + ": " + opt.fmt(p.v)) + "</title></rect>";
    } else {
      const live = pts.filter((p) => p.v != null);
      if (live.length > 1) body += '<polyline fill="none" class="sd-line" points="' + live.map((p) => x(p.i).toFixed(1) + "," + y(p.v).toFixed(1)).join(" ") + '"/>';
      for (const p of live) body += '<circle cx="' + x(p.i).toFixed(1) + '" cy="' + y(p.v).toFixed(1) + '" r="3" class="sd-dot"><title>' + esc(p.d + ": " + opt.fmt(p.v)) + "</title></circle>";
    }
    if (opt.goal != null) body += '<line x1="0" x2="' + W + '" y1="' + y(opt.goal).toFixed(1) + '" y2="' + y(opt.goal).toFixed(1) + '" class="sd-goal"/>';
    const note = days.length < 3 ? '<div class="sd-chnote">' + days.length + " day" + (days.length === 1 ? "" : "s") + " so far · fills in over 30 days</div>" : "";
    return '<svg viewBox="0 0 ' + W + " " + H + '" preserveAspectRatio="none" class="sd-svg" role="img" aria-label="' + esc(opt.label) + '">' + body + "</svg>" + note;
  }
  // What to do next, most important first: [level 0 urgent / 1 soon / 2 nice, text, task title].
  function todo(c, days) {
    const out = [], st = c.st || {}, tg = c.tags, upAvg = avg(days.map((d) => d.up).filter((v) => v != null));
    const ms = avg(days.slice(-7).map((d) => d.ms).filter((v) => v != null)), score = c.ps && c.ps.score != null ? c.ps.score : null;
    const dsk = c.ps && c.ps.d && c.ps.d.score != null ? c.ps.d.score : null, cr = c.ps && c.ps.crux;
    const dom = (c.ps && c.ps.dom) || (c.rec && c.rec.pageDom) || 0, kb = c.rec && c.rec.pageKb, gz = c.rec && c.rec.pageGzKb;
    if (st.up === false) out.push([0, "The site is down right now. Check the hosting panel and the server's error log first.", "Site is down - investigate"]);
    if (st.blocked) out.push([1, "Its security is challenging this check (" + st.blocked + "). Ask whoever manages it to allow this office's IP, or the monitor can't see real outages.", "Allow the uptime check through the firewall"]);
    if (upAvg != null && upAvg < 99) out.push([0, "Uptime was " + upAvg.toFixed(1) + "% over the last " + days.length + " days. Ask the host about the outages, or move it to steadier hosting.", "Fix repeated downtime (" + upAvg.toFixed(1) + "% uptime)"]);
    if (c.pz && /not patched|end of life|risk/i.test(c.pz.text || "")) out.push([0, c.pz.text + ". Update it in the hosting panel (test on staging first).", "Update PHP (" + c.pz.text + ")"]);
    if (c.wz && c.wz.k !== "ok" && /→|out of date/i.test(c.wz.text || "")) out.push([1, "WordPress " + c.wz.text.replace(/→/, "can go to") + ". Back up, then update WordPress and its plugins.", "Update WordPress " + c.wz.text]);
    const crd = c.ps && c.ps.d && c.ps.d.crux;
    if (crd && crd.overall && crd.overall !== "FAST" && !(cr && cr.overall && cr.overall !== "FAST")) out.push([crd.overall === "SLOW" ? 0 : 1, "Core Web Vitals fail for real desktop visitors (last 28 days)" + (crd.lcp && crd.lcp.c !== "FAST" ? ": LCP " + (crd.lcp.v / 1000).toFixed(1) + "s" : "") + (crd.inp && crd.inp.c !== "FAST" ? ", INP " + Math.round(crd.inp.v) + "ms" : "") + (crd.cls && crd.cls.c !== "FAST" ? ", CLS " + crd.cls.v : "") + ". Google uses this for rankings.", "Pass Core Web Vitals on desktop (real-user data)"]);
    if (cr && cr.overall && cr.overall !== "FAST") out.push([cr.overall === "SLOW" ? 0 : 1, "Core Web Vitals fail for real mobile visitors (last 28 days)" + (cr.lcp && cr.lcp.c !== "FAST" ? ": LCP " + (cr.lcp.v / 1000).toFixed(1) + "s" : "") + (cr.inp && cr.inp.c !== "FAST" ? ", INP " + Math.round(cr.inp.v) + "ms" : "") + (cr.cls && cr.cls.c !== "FAST" ? ", CLS " + cr.cls.v : "") + ". Google uses this for rankings.", "Pass Core Web Vitals (real-user data)"]);
    if (score != null && score < 50) out.push([1, "PageSpeed (mobile) is " + score + (dsk != null ? ", desktop " + dsk : "") + ". Start with the largest images (WebP, lazy load), then caching and unused scripts" + (c.ps.lcp ? "; the largest paint takes " + c.ps.lcp : "") + ".", "Improve mobile PageSpeed (" + score + ")"]);
    else if (score != null && score < 90) out.push([2, "PageSpeed (mobile) is " + score + (dsk != null ? ", desktop " + dsk : "") + ". Compress images and defer scripts that aren't needed above the fold to reach 90+.", "Raise mobile PageSpeed to 90+ (now " + score + ")"]);
    if (dsk != null && dsk < 50) out.push([1, "PageSpeed (desktop) is " + dsk + ". Heavy scripts or unoptimised images slow even fast computers.", "Improve desktop PageSpeed (" + dsk + ")"]);
    if (ms != null && ms > 2000) out.push([1, "The server takes " + msTxt(ms) + " to answer on average. Turn on page caching, or ask the host about server speed.", "Speed up server response (" + msTxt(ms) + ")"]);
    if (dom > 1500) out.push([2, "The page has " + dom.toLocaleString() + " elements (Google suggests under 1,500). Simplify heavy sections (sliders, mega menus, page-builder wrappers).", "Reduce DOM size (" + dom.toLocaleString() + " elements)"]);
    if (kb && gz && kb > 100 && gz / kb > 0.6) out.push([1, "The page goes over the network almost uncompressed (" + kbTxt(gz) + " of " + kbTxt(kb) + "). Turn on Gzip or Brotli compression on the server or CDN.", "Turn on Gzip / Brotli compression"]);
    else if (kb && kb > 800) out.push([2, "The HTML alone is " + kbTxt(kb) + (gz ? " (" + kbTxt(gz) + " sent)" : "") + ". Inline scripts, styles or page-builder markup are bloating it.", "Slim down the page HTML (" + kbTxt(kb) + ")"]);
    if (tg) {
      if (!tg.ga.length && !tg.gaUnknown) out.push([1, "No Google Analytics found. Add GA4 (or add it to the GTM container) so traffic can be tracked.", "Add Google Analytics (GA4)"]);
      if (!tg.gtm.length && !tg.gtmHand) out.push([2, "No Google Tag Manager. Optional, but it makes adding tracking later much easier.", "Add Google Tag Manager"]);
      if (tg.gtm.length > 1) out.push([1, "More than one GTM container loads (" + tg.gtm.join(", ") + "). Check visits aren't counted twice.", "Remove the extra GTM container"]);
      if (!tg.clarity) out.push([2, "No Microsoft Clarity. Free heatmaps and recordings show where visitors get stuck.", "Add Microsoft Clarity"]);
    }
    if (!out.length) out.push([2, "Nothing needs attention. Keep an eye on the trend.", ""]);
    return out.sort((a, b) => a[0] - b[0]);
  }
  function verdict(days) {
    const t = [trend(days, "ms", true), trend(days, "score", false), trend(days, "up", false)].filter(Boolean);
    if (!t.length) return { k: "steady", text: "Not enough history yet for a trend (needs about a week of checks)." };
    const w = t.filter((x) => x.k === "worse").length, b = t.filter((x) => x.k === "better").length;
    return w > b ? { k: "worse", text: "Getting worse over the last week." } : b > w ? { k: "better", text: "Improving over the last week." } : { k: "steady", text: "Holding steady." };
  }

  // ---------- Performance card (PageSpeed) ----------
  // Google's thresholds: good up to the first number, poor past the second; the bar runs to max.
  const METRICS = [
    ["lcp", "LCP", "Largest Contentful Paint: when the main content shows", 2500, 4000, 6000, (v) => (v / 1000).toFixed(1) + " sec"],
    ["cls", "CLS", "Cumulative Layout Shift: how much the page jumps while loading", 0.1, 0.25, 0.4, (v) => String(v)],
    ["tbt", "TBT", "Total Blocking Time: how long scripts freeze the page", 200, 600, 1000, (v) => Math.round(v) + " ms"],
    ["fcp", "FCP", "First Contentful Paint: when anything first shows", 1800, 3000, 4500, (v) => (v / 1000).toFixed(1) + " sec"],
    ["si", "Speed Index", "How quickly the page visibly fills in", 3400, 5800, 8000, (v) => (v / 1000).toFixed(1) + " sec"],
  ];
  // Real visitors (Chrome UX Report, 75th percentile): the three Core Web Vitals.
  const CWV = [
    ["lcp", "LCP", "Largest Contentful Paint for real visitors", 2500, 4000, 6000, (v) => (v / 1000).toFixed(1) + " sec"],
    ["inp", "INP", "Interaction to Next Paint: how fast the page reacts to a tap or click", 200, 500, 800, (v) => Math.round(v) + " ms"],
    ["cls", "CLS", "Cumulative Layout Shift for real visitors", 0.1, 0.25, 0.4, (v) => String(v)],
  ];
  const zone = (score) => (score >= 90 ? "good" : score >= 50 ? "mid" : "poor");
  // The score in a ring (also used small in Site monitor's Page column).
  function ring(score, size) {
    const r = 42, c = 2 * Math.PI * r, z = zone(score);
    return '<svg class="sd-ring ' + z + '" viewBox="0 0 100 100" width="' + size + '" height="' + size + '" role="img" aria-label="PageSpeed ' + score + '">' +
      '<circle cx="50" cy="50" r="' + r + '" class="sd-ring-bg"/><circle cx="50" cy="50" r="' + r + '" class="sd-ring-fg" stroke-dasharray="' + (c * score / 100).toFixed(1) + " " + c.toFixed(1) + '" transform="rotate(-90 50 50)"/>' +
      '<text x="50" y="50" dy=".36em" text-anchor="middle">' + score + "</text></svg>";
  }
  function bars(list, vals) {
    return list.filter(([k]) => vals[k] != null).map(([k, lab, tip, good, poor, max, fmt]) => {
      const v = vals[k], z = v <= good ? "good" : v <= poor ? "mid" : "poor", pos = Math.min(100, (v / max) * 100);
      return '<div class="sd-met" title="' + esc(tip) + '"><div class="sd-met-h"><i class="' + z + '"></i><b>' + lab + '</b><span class="' + z + '">' + fmt(v) + "</span></div>" +
        '<div class="sd-met-bar"><s class="good" style="width:' + (good / max * 100).toFixed(1) + '%"></s><s class="mid" style="width:' + ((poor - good) / max * 100).toFixed(1) + '%"></s><s class="poor"></s><em style="left:' + pos.toFixed(1) + '%"></em></div></div>';
    }).join("");
  }
  function side(label, icon, r, running) {
    const head = '<div class="sd-side-h">' + icon + " " + label + (r && r.at ? '<small title="' + esc(new Date(r.at).toLocaleString()) + '">tested ' + ago(r.at) + (r.ok === false && r.score != null ? " (last test failed, showing the one before)" : "") + "</small>" : "") + "</div>";
    if (!r || r.score == null) return '<div class="sd-side">' + head + '<div class="sd-empty">' + (running ? '<i class="sm-spin"></i> Testing now…' : r && r.err ? "The last test failed (" + esc(r.err) + ")." : "Not tested yet - it's tested automatically, a few sites every 5 minutes.") + "</div></div>";
    const rows = bars(METRICS, r.m || {});
    return '<div class="sd-side">' + head + '<div class="sd-side-b"><div class="sd-perf-ring">' + ring(r.score, 112) + "</div>" +
      '<div class="sd-mets">' + (rows || '<div class="sd-empty">LCP, CLS and TBT come with the next test.</div>') + "</div></div></div>";
  }
  // Real visitors (Chrome UX Report, 28 days) - Google reports phones and computers
  // separately, so one row each, with a plain sentence on what the verdict means.
  function cruxRow(label, icon, cr) {
    if (!cr) return '<div class="sd-crow"><div class="sd-crow-h">' + icon + " <b>" + label + '</b><span class="sd-cwv none">No data</span><small>Not enough ' + label.toLowerCase() + " visitors for Google to report real-visitor numbers. The lab test below still shows how it loads.</small></div></div>";
    const vals = {}; for (const k of ["lcp", "inp", "cls"]) if (cr[k]) vals[k] = cr[k].v;
    const bad = CWV.filter(([k]) => cr[k] && cr[k].c && cr[k].c !== "FAST");
    const pass = cr.overall === "FAST" || (Object.keys(vals).length && !bad.length);
    const say = pass ? "All three are good for at least 75% of real " + label.toLowerCase() + " visitors - this passes Google's Core Web Vitals check."
      : bad.map(([k, l, , , , , f]) => l + " " + f(cr[k].v) + (cr[k].c === "SLOW" ? " (poor)" : " (needs work)")).join(", ") + " for " + label.toLowerCase() + " visitors - fix " + (bad.length === 1 ? "it" : "these") + " to pass Google's Core Web Vitals check.";
    return '<div class="sd-crow"><div class="sd-crow-h">' + icon + " <b>" + label + '</b><span class="sd-cwv ' + (pass ? "pass" : "fail") + '">' + (pass ? "Passed" : "Needs work") + "</span><small>" + esc(say) + (cr.scope === "site" ? " (whole site - this page has too few visits on its own)" : "") + '</small></div><div class="sd-mets sd-mets3">' + bars(CWV, vals) + "</div></div>";
  }
  function cruxBlock(mob, desk) {
    return '<div class="sd-crux"><div class="sd-crux-h"><b>Core Web Vitals</b><small>real visitors, last 28 days (what Google uses for rankings)</small></div>' + cruxRow("Mobile", "📱", mob) + cruxRow("Desktop", "🖥", desk) + "</div>";
  }
  function perfCard(ps, hasKey, running, runs) {
    const r0 = runs || {};
    const runSel = '<label class="sd-runs" title="How many PageSpeed runs are averaged into one score for this site (Site monitor › Tools › PageSpeed settings sets it for every site)">Average <select class="sd-runsel"><option value="">' + (r0.all || 1) + " (all sites)</option>" + [1, 2, 3, 4, 5].map((n) => '<option value="' + n + '"' + (r0.site === n ? " selected" : "") + ">" + n + "</option>").join("") + "</select> run" + ((r0.site || r0.all || 1) === 1 ? "" : "s") + "</label>";
    const tuneBtn = ps && ps.score != null && ps.m ? '<button type="button" class="sd-tunebtn" title="Drag each metric to see what score it would give - like Google\'s Lighthouse score calculator">🎛 Try tuning</button>' : "";
    const head = '<div class="sd-perf-h"><span>PERFORMANCE</span><small>Google PageSpeed' + (ps && ps.n > 1 ? " · average of " + ps.n + " runs" : "") + '</small><span class="sd-sp"></span>' +
      (running ? '<span class="sd-testing"><i class="sm-spin"></i>Testing…</span>' : "") + (hasKey ? runSel : "") + tuneBtn +
      '<button type="button" class="sd-psi"' + (hasKey && !running ? "" : " disabled") + (hasKey ? ' title="Test this site again now (mobile and desktop, up to a minute)"' : ' title="Add a PageSpeed key first: Site monitor › Tools › PageSpeed key"') + ">Test now</button></div>";
    if (!hasKey && (!ps || ps.score == null)) return '<div class="sd-perf">' + head + '<div class="sd-empty">PageSpeed needs a free Google key: Site monitor › Tools › PageSpeed key.</div></div>';
    return '<div class="sd-perf">' + head + (ps && ps.score != null ? cruxBlock(ps.crux, ps.d && ps.d.crux) : "") +
      '<div class="sd-sides">' + side("Mobile", "📱", ps, running) + side("Desktop", "🖥", ps && ps.d, running) + '</div><div class="sd-tune" hidden></div></div>';
  }

  // ---------- Try tuning: Lighthouse's own score formula (v10+ weights and curves) ----------
  // Each metric's score is a log-normal curve set by Google's p10 (scores 0.9) and median
  // (scores 0.5); the overall score is the weighted sum. Checked against real tests.
  const LH = {
    mobile: { fcp: [1800, 3000, 0.1], si: [3387, 5800, 0.1], lcp: [2500, 4000, 0.25], tbt: [200, 600, 0.3], cls: [0.1, 0.25, 0.25] },
    desktop: { fcp: [934, 1600, 0.1], si: [1311, 2300, 0.1], lcp: [1200, 2400, 0.25], tbt: [150, 350, 0.3], cls: [0.1, 0.25, 0.25] },
  };
  function erf(x) { const sg = Math.sign(x); x = Math.abs(x); const t = 1 / (1 + 0.3275911 * x); const y = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429)))); return sg * (1 - y * Math.exp(-x * x)); }
  function metricScore(dev, k, v) {
    const [p10, med] = LH[dev][k];
    if (v <= 0) return 1;
    const z = (Math.log(v / med) * 0.9062373725657001) / -Math.log(p10 / med), c = (1 - erf(z)) / 2;
    return v <= p10 ? Math.max(0.9, Math.min(1, c)) : v <= med ? Math.max(0.5, Math.min(0.89999999999999, c)) : Math.max(0, Math.min(0.499999999999, c));
  }
  function lhScore(dev, m) {
    let sum = 0;
    for (const k of Object.keys(LH[dev])) sum += LH[dev][k][2] * metricScore(dev, k, Number(m[k]) || 0);
    return Math.round(sum * 100);
  }
  const TUNE = [["fcp", "FCP", 0, 10000, 10, (v) => (v / 1000).toFixed(1) + " s"], ["si", "Speed Index", 0, 15000, 10, (v) => (v / 1000).toFixed(1) + " s"], ["lcp", "LCP", 0, 15000, 10, (v) => (v / 1000).toFixed(1) + " s"], ["tbt", "TBT", 0, 3000, 10, (v) => Math.round(v) + " ms"], ["cls", "CLS", 0, 1, 0.001, (v) => Number(v).toFixed(3)]];
  function tune(boxEl, ps) {
    const dev0 = boxEl.dataset.dev || "mobile", src = dev0 === "desktop" ? ps.d : ps;
    const vals = {};
    for (const [k] of TUNE) vals[k] = src && src.m && src.m[k] != null ? src.m[k] : 0;
    const paint = () => {
      const dev = boxEl.dataset.dev || "mobile", now = lhScore(dev, vals);
      // Biggest win: the points each metric would add if it reached Google's "good" (p10).
      const gains = Object.keys(LH[dev]).map((k) => { const best = { ...vals, [k]: Math.min(vals[k], LH[dev][k][0]) }; return [k, lhScore(dev, best) - now]; }).sort((a, b) => b[1] - a[1]);
      const lab = (k) => TUNE.find((t) => t[0] === k)[1];
      boxEl.querySelector(".sd-tune-ring").innerHTML = ring(now, 96);
      boxEl.querySelector(".sd-tune-win").innerHTML = gains[0][1] > 0 ? "Biggest win: <b>" + lab(gains[0][0]) + "</b> to Google's good mark gives <b>+" + gains[0][1] + "</b> points" + (gains[1][1] > 0 ? ", then " + lab(gains[1][0]) + " (+" + gains[1][1] + ")" : "") + "." : "Every metric is already at Google's good mark.";
      for (const [k, , , , , fmt] of TUNE) {
        const row = boxEl.querySelector('[data-tk="' + k + '"]'), ms = metricScore(dev, k, vals[k]), w = LH[dev][k][2];
        row.querySelector(".sd-tv").textContent = fmt(vals[k]);
        row.querySelector(".sd-tp").textContent = Math.round(ms * w * 100) + " / " + Math.round(w * 100) + " pts";
        row.querySelector(".sd-tv").className = "sd-tv " + (ms >= 0.9 ? "good" : ms >= 0.5 ? "mid" : "poor");
      }
    };
    boxEl.innerHTML = '<div class="sd-tune-h"><b>Try tuning</b><span class="hint">Drag a metric to see the score it would give (Lighthouse\'s own formula). Starts from this site\'s last test.</span><span class="sd-sp"></span>' +
      '<span class="sd-seg"><button type="button" data-dev="mobile"' + (dev0 === "mobile" ? ' class="on"' : "") + ">📱 Mobile</button><button type=\"button\" data-dev=\"desktop\"" + (dev0 === "desktop" ? ' class="on"' : "") + '>🖥 Desktop</button></span><button type="button" class="sd-tune-reset">Reset</button></div>' +
      '<div class="sd-tune-b"><div class="sd-tune-ring"></div><div class="sd-tune-rows">' +
      TUNE.map(([k, lab, min, max, step]) => '<div class="sd-trow" data-tk="' + k + '"><b>' + lab + '</b><input type="range" min="' + min + '" max="' + max + '" step="' + step + '" value="' + vals[k] + '" /><span class="sd-tv"></span><span class="sd-tp"></span></div>').join("") +
      '</div></div><div class="sd-tune-win"></div>';
    boxEl.querySelectorAll(".sd-trow input").forEach((inp) => { inp.oninput = () => { vals[inp.closest(".sd-trow").dataset.tk] = Number(inp.value); paint(); }; });
    boxEl.querySelectorAll("[data-dev]").forEach((b) => { b.onclick = () => { boxEl.dataset.dev = b.dataset.dev; tune(boxEl, ps); }; });
    boxEl.querySelector(".sd-tune-reset").onclick = () => tune(boxEl, ps);
    paint();
  }

  // ---------- Share / Add to task ----------
  function report(c, days) {
    const ps = c.ps || {}, st = c.st || {}, lines = [];
    lines.push(siteName(c) + " - site check (" + new Date().toLocaleDateString() + ")", c.site.url, "");
    lines.push("Status: " + (st.up === true ? "Up" : st.up === false ? "Down" : "not checked") + (st.lastMs ? " · reply " + msTxt(st.lastMs) : ""));
    const upAvg = avg(days.map((d) => d.up).filter((v) => v != null));
    if (upAvg != null) lines.push("Uptime: " + upAvg.toFixed(2) + "% (last " + days.length + " day" + (days.length === 1 ? "" : "s") + ")");
    const one = (lab, r) => r && r.score != null ? lab + ": " + r.score + (r.m ? " · " + METRICS.filter(([k]) => r.m[k] != null).map(([k, l, , , , , f]) => l + " " + f(r.m[k])).join(", ") : "") : "";
    [one("PageSpeed mobile", ps), one("PageSpeed desktop", ps.d)].filter(Boolean).forEach((l) => lines.push(l));
    const cw = (lab, cr) => { if (cr) lines.push("Core Web Vitals " + lab + " (real visitors): " + (cr.overall === "FAST" ? "Passed" : "Needs work") + " · " + CWV.filter(([k]) => cr[k]).map(([k, l, , , , , f]) => l + " " + f(cr[k].v)).join(", ")); };
    cw("mobile", ps.crux); cw("desktop", ps.d && ps.d.crux);
    const dom = ps.dom || (c.rec && c.rec.pageDom);
    if (c.rec && c.rec.pageKb) lines.push("Page: " + kbTxt(c.rec.pageKb) + (c.rec.pageGzKb ? " (" + kbTxt(c.rec.pageGzKb) + " sent)" : "") + (dom ? " · DOM " + Number(dom).toLocaleString() + " elements" : ""));
    lines.push("", "To do:");
    todo(c, days).forEach((t) => lines.push("- [" + ["Fix now", "Soon", "Nice to have"][t[0]] + "] " + t[1]));
    return lines.join("\n");
  }

  // ---------- Share: the site report as a page / PDF / HTML file / formatted copy ----------
  function reportHtml(c, days) {
    const ps = c.ps || {}, st = c.st || {}, g = c._gd && c._gd.gsc, a = c._gd && c._gd.ga, n = siteName(c);
    const col = { good: "#0a9e54", mid: "#d98a00", poor: "#e5392d" };
    const zc = (sc) => (sc >= 90 ? col.good : sc >= 50 ? col.mid : col.poor);
    const ringSvg = (sc) => { const r = 42, C = 2 * Math.PI * r; return '<svg width="96" height="96" viewBox="0 0 100 100"><circle cx="50" cy="50" r="' + r + '" fill="' + zc(sc) + '14" stroke="' + zc(sc) + '33" stroke-width="9"/><circle cx="50" cy="50" r="' + r + '" fill="none" stroke="' + zc(sc) + '" stroke-width="9" stroke-linecap="round" stroke-dasharray="' + (C * sc / 100).toFixed(1) + " " + C.toFixed(1) + '" transform="rotate(-90 50 50)"/><text x="50" y="50" dy=".36em" text-anchor="middle" font-size="32" font-weight="800" fill="' + zc(sc) + '" font-family="Segoe UI,Arial,sans-serif">' + sc + "</text></svg>"; };
    const met = (list, vals) => list.filter(([k]) => vals && vals[k] != null).map(([k, lab, , good, poor, , fmt]) => { const v = vals[k], z = v <= good ? "good" : v <= poor ? "mid" : "poor"; return "<tr><td>" + lab + '</td><td style="text-align:right;font-weight:700;color:' + col[z] + '">' + fmt(v) + '</td><td style="color:' + col[z] + '">' + (z === "good" ? "Good" : z === "mid" ? "Needs work" : "Poor") + "</td></tr>"; }).join("");
    const side = (lab, r) => !r || r.score == null ? "" : '<td style="vertical-align:top;padding:0 18px 0 0;width:50%"><div style="font-weight:700;margin-bottom:6px">' + lab + '</div><table style="border-collapse:collapse"><tr><td style="padding-right:14px;vertical-align:middle">' + ringSvg(r.score) + '</td><td><table class="t">' + met(METRICS, r.m) + "</table></td></tr></table></td>";
    const cwv = (lab, cr) => { if (!cr) return "<tr><td>" + lab + '</td><td colspan="3" style="color:#777">Not enough real visitors for Google to report</td></tr>'; const bad = CWV.filter(([k]) => cr[k] && cr[k].c && cr[k].c !== "FAST"); const pass = cr.overall === "FAST" || !bad.length; return "<tr><td>" + lab + '</td><td style="font-weight:700;color:' + (pass ? col.good : col.poor) + '">' + (pass ? "Passed" : "Needs work") + "</td><td>" + CWV.filter(([k]) => cr[k]).map(([k, l, , , , , f]) => l + " " + f(cr[k].v)).join(" · ") + "</td></tr>"; };
    const pc = (cur, prev, low) => { if (cur == null || prev == null) return ""; const p = prev ? ((cur - prev) / prev) * 100 : 0; if (Math.abs(p) < 2) return '<span style="color:#777">→ same</span>'; const good = low ? p < 0 : p > 0; return '<span style="color:' + (good ? col.good : col.poor) + '">' + (p > 0 ? "▲ " : "▼ ") + Math.abs(Math.round(p)) + "%</span>"; };
    const kpi = (lab, val, d) => '<td class="k"><div class="kl">' + lab + '</div><div class="kv">' + val + '</div><div class="kd">' + (d || "") + "</div></td>";
    const nfx = (x) => Math.round(Number(x) || 0).toLocaleString();
    const chartImg = (o) => { try { return bigChart(o).replace(/<rect class="bc-hit"[^>]*\/>/, "").replace(/<line class="bc-cross"[^>]*\/>/, ""); } catch (e) { return ""; } };
    const colv = (list, k) => (list || []).map((x) => x[k]);
    const v = c._gd ? gdVerdict(c._gd) : null;
    const items = todo(c, days), lv = ["Fix now", "Soon", "Nice to have"], lvc = [col.poor, col.mid, "#777"];
    const upAvg = avg(days.map((d) => d.up).filter((x) => x != null));
    const dom = ps.dom || (c.rec && c.rec.pageDom);
    let h = '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' + esc(n) + " - site report " + new Date().toLocaleDateString() + "</title><style>" +
      "body{font-family:'Segoe UI',Arial,sans-serif;color:#1f2430;max-width:900px;margin:24px auto;padding:0 20px;line-height:1.45;font-size:14px}h1{font-size:24px;margin:0 0 2px}h2{font-size:15px;letter-spacing:.12em;text-transform:uppercase;color:#6b6f7a;margin:28px 0 10px;border-bottom:2px solid #f0c419;padding-bottom:6px}" +
      ".sub{color:#6b6f7a}.chip{display:inline-block;padding:2px 10px;border-radius:999px;font-weight:700;font-size:12px}table.t{border-collapse:collapse;width:100%}table.t td,table.t th{padding:5px 8px;border-bottom:1px solid #eee;text-align:left;font-size:13px}table.t th{color:#6b6f7a;font-weight:600;font-size:12px}" +
      "table.kp{border-collapse:separate;border-spacing:8px;width:100%;margin:0 -8px}td.k{border:1px solid #e6e6e6;border-radius:10px;padding:10px 12px;vertical-align:top}.kl{font-size:11px;text-transform:uppercase;color:#6b6f7a;font-weight:600}.kv{font-size:22px;font-weight:700}.kd{font-size:12px}" +
      ".bc{border:1px solid #e6e6e6;border-radius:10px;padding:10px 12px;margin:10px 0}.bc-h{display:flex;justify-content:space-between;font-size:13px;margin-bottom:4px}.bc-legs button{border:1px solid #ddd;background:#fff;border-radius:999px;padding:2px 9px;font-size:11px;margin-left:4px}.bc-legs i{display:inline-block;width:9px;height:9px;border-radius:2px;background:var(--c);margin-right:5px}.bc-prevkey{font-size:11px;color:#777;margin-left:6px}.bc-svg{width:100%;height:auto}.bc-grid{stroke:#eee}.bc-ax{fill:#888;font-size:11px}.bc-tip{display:none}" +
      ".todo li{margin:6px 0}.foot{margin-top:32px;color:#999;font-size:12px;border-top:1px solid #eee;padding-top:10px}@media print{body{margin:0}h2{break-after:avoid}.bc,table{break-inside:avoid}}" +
      "</style></head><body>";
    h += "<h1>" + esc(n) + '</h1><div class="sub">' + esc(c.site.url) + " · report of " + esc(new Date().toLocaleDateString([], { year: "numeric", month: "long", day: "numeric" })) + "</div>";
    h += '<p><span class="chip" style="background:' + (st.up === false ? "#fde8e6;color:" + col.poor : "#e3f6ec;color:" + col.good) + '">' + (st.up === false ? "Down" : st.up === true ? "Up" : "Not checked") + "</span>" + (st.lastMs ? ' <span class="sub">reply ' + msTxt(st.lastMs) + "</span>" : "") + (upAvg != null ? ' <span class="sub">· uptime ' + upAvg.toFixed(2) + "% (last " + days.length + " day" + (days.length === 1 ? "" : "s") + ")</span>" : "") + "</p>";
    if (ps.score != null) {
      h += "<h2>Page speed (Google PageSpeed)</h2><table style=\"width:100%;border-collapse:collapse\"><tr>" + side("📱 Mobile", ps) + side("🖥 Desktop", ps.d) + "</tr></table>";
      h += '<h2>Core Web Vitals (real visitors, 28 days)</h2><table class="t">' + cwv("📱 Mobile", ps.crux) + cwv("🖥 Desktop", ps.d && ps.d.crux) + "</table>";
    }
    if (g || a) {
      h += "<h2>Search &amp; traffic (last 28 days vs the 28 before)</h2>" + (v ? '<p style="font-weight:600;color:' + (v.k === "better" ? col.good : v.k === "worse" ? col.poor : "#555") + '">' + esc(v.text) + "</p>" : "");
      h += '<table class="kp"><tr>' + (g ? kpi("Clicks", nfx(g.cur.clicks), pc(g.cur.clicks, g.prev.clicks)) + kpi("Impressions", nfx(g.cur.imp), pc(g.cur.imp, g.prev.imp)) + kpi("Avg position", g.cur.pos != null ? g.cur.pos.toFixed(1) : "-", pc(g.cur.pos, g.prev.pos, true)) + kpi("CTR", (g.cur.ctr * 100).toFixed(1) + "%", pc(g.cur.ctr, g.prev.ctr)) : "") + "</tr>" +
        (a ? "<tr>" + kpi("Organic visits", nfx(a.cur.organic), pc(a.cur.organic, a.prev.organic)) + kpi("All visits", nfx(a.cur.sessions), pc(a.cur.sessions, a.prev.sessions)) + kpi("Users", nfx(a.cur.users), pc(a.cur.users, a.prev.users)) + kpi("Key events", nfx(a.cur.keyEvents), pc(a.cur.keyEvents, a.prev.keyEvents)) + "</tr>" : "") + "</table>";
      if (g && g.daily && g.daily.length) h += chartImg({ title: "Google Search: clicks and impressions", labels: g.daily.map((x) => x.d), series: [{ name: "Clicks", color: "#4285f4", vals: colv(g.daily, "v"), prev: colv(g.prevDaily, "v"), axis: "l" }, { name: "Impressions", color: "#7b5cd6", vals: colv(g.daily, "imp"), prev: colv(g.prevDaily, "imp"), axis: "r" }] });
      if (a && a.daily && a.daily.length) h += chartImg({ title: "Analytics: visits", labels: a.daily.map((x) => x.d), series: [{ name: "Organic visits", color: "#1a9e5a", vals: colv(a.daily, "o"), prev: colv(a.prevDaily, "o"), axis: "l" }, { name: "All visits", color: "#f29900", vals: colv(a.daily, "v"), prev: colv(a.prevDaily, "v"), axis: "l" }] });
      if (g && g.queries && g.queries.length) h += '<h2>Top searches</h2><table class="t"><tr><th>Search</th><th>Clicks</th><th>Impressions</th><th>Position</th></tr>' + g.queries.map((q) => "<tr><td>" + esc(q.q) + "</td><td>" + nfx(q.clicks) + "</td><td>" + nfx(q.imp) + "</td><td>" + q.pos.toFixed(1) + "</td></tr>").join("") + "</table>";
      if (g && g.pages && g.pages.length) h += '<h2>Top pages from Google</h2><table class="t"><tr><th>Page</th><th>Clicks</th><th>Impressions</th></tr>' + g.pages.map((p) => "<tr><td>" + esc(p.p) + "</td><td>" + nfx(p.clicks) + "</td><td>" + nfx(p.imp) + "</td></tr>").join("") + "</table>";
    }
    h += '<h2>Page</h2><table class="t"><tr><td>Page size</td><td>' + (c.rec && c.rec.pageKb ? kbTxt(c.rec.pageKb) + (c.rec.pageGzKb ? " (" + kbTxt(c.rec.pageGzKb) + " sent compressed)" : "") : "-") + "</td></tr><tr><td>DOM size</td><td>" + (dom ? Number(dom).toLocaleString() + " elements (Google suggests under 1,500)" : "-") + "</td></tr>" +
      (c.wz ? "<tr><td>WordPress</td><td>" + esc(c.wz.text) + "</td></tr>" : "") + (c.rec && c.pz ? "<tr><td>PHP</td><td>" + esc(c.pz.text) + "</td></tr>" : "") + "</table>";
    h += '<h2>What to do next</h2><ol class="todo">' + items.map((t) => '<li><b style="color:' + lvc[t[0]] + '">' + lv[t[0]] + ":</b> " + esc(t[1]) + "</li>").join("") + "</ol>";
    h += '<div class="foot">Search data from Google Search Console and Google Analytics 4; speed from Google PageSpeed Insights' + (ps.at ? " (tested " + esc(new Date(ps.at).toLocaleDateString()) + ")" : "") + ".</div></body></html>";
    return h;
  }
  function shareMenu(btn, c, days, say) {
    const old = document.querySelector(".sd-sharemenu");
    if (old) { old.remove(); return; }
    const m = document.createElement("div");
    m.className = "sd-sharemenu";
    const opts = [
      ["page", "🗎 Open as a page", "A clean report in a new tab"],
      ["pdf", "⬇ Save as PDF", "Opens the report with the print box - pick Save as PDF"],
      ["html", "⬇ Download HTML file", "One file you can email or upload"],
      ["rich", "📋 Copy formatted", "Paste into Gmail, Google Docs, ClickUp, Slack"],
      ["text", "📋 Copy as text", "Plain text"],
    ];
    m.innerHTML = opts.map(([k, l, d]) => '<button type="button" data-k="' + k + '"><b>' + l + "</b><small>" + d + "</small></button>").join("") + (c._gd ? "" : '<div class="sd-sharenote">Search &amp; traffic is added once it has loaded on this page.</div>');
    btn.parentElement.appendChild(m);
    const fileName = siteName(c).replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "-") + "-site-report-" + new Date().toISOString().slice(0, 10);
    const off = (e) => { if (!m.contains(e.target) && e.target !== btn) { m.remove(); document.removeEventListener("mousedown", off, true); } };
    document.addEventListener("mousedown", off, true);
    m.querySelectorAll("button").forEach((b) => { b.onclick = async () => {
      const k = b.dataset.k, html = reportHtml(c, days);
      m.remove(); document.removeEventListener("mousedown", off, true);
      try {
        if (k === "text") { await navigator.clipboard.writeText(report(c, days)); say("Report copied as text."); return; }
        if (k === "rich") {
          const body = html.replace(/^[\s\S]*<body>/, "").replace(/<\/body>[\s\S]*$/, ""), css = (html.match(/<style>([\s\S]*?)<\/style>/) || ["", ""])[1];
          await navigator.clipboard.write([new ClipboardItem({ "text/html": new Blob(["<style>" + css + "</style>" + body], { type: "text/html" }), "text/plain": new Blob([report(c, days)], { type: "text/plain" }) })]);
          say("Formatted report copied - paste it into an email, Doc or task."); return;
        }
        const url = URL.createObjectURL(new Blob([html], { type: "text/html" }));
        if (k === "html") { const a2 = document.createElement("a"); a2.href = url; a2.download = fileName + ".html"; document.body.appendChild(a2); a2.click(); a2.remove(); setTimeout(() => URL.revokeObjectURL(url), 30000); say("Report downloaded."); return; }
        const w = window.open(url, "_blank");
        if (!w) { say("Allow pop-ups for the extension to open the report."); return; }
        if (k === "pdf") w.addEventListener("load", () => setTimeout(() => { try { w.document.title = fileName; w.focus(); w.print(); } catch (e) {} }, 300));
        setTimeout(() => URL.revokeObjectURL(url), 120000);
      } catch (e) { say("Couldn't share: " + ((e && e.message) || e)); }
    }; });
  }
  function taskFor(c, item, days) {
    const ps = c.ps || {}, n = siteName(c);
    const md = "**Site:** " + c.site.url + "\n\n**What to fix:** " + item[1] + "\n\n" +
      (ps.score != null ? "**PageSpeed:** mobile " + ps.score + (ps.d && ps.d.score != null ? ", desktop " + ps.d.score : "") + (ps.m ? " (LCP " + (ps.m.lcp != null ? (ps.m.lcp / 1000).toFixed(1) + "s" : "-") + ", CLS " + (ps.m.cls != null ? ps.m.cls : "-") + ", TBT " + (ps.m.tbt != null ? Math.round(ps.m.tbt) + "ms" : "-") + ")" : "") + "\n\n" : "") +
      "**Check it:** https://pagespeed.web.dev/analysis?url=" + encodeURIComponent(c.site.url) + "\n\nFile: \"\"";
    return { name: n + ": " + item[2], md, focus: "people", clientQ: n.replace(/\s+SEO$/i, ""), priority: item[0] === 0 ? "high" : item[0] === 1 ? "normal" : "" };
  }
  function addTask(c, item, days, msg) {
    if (!window.PcmLocalTasks || !window.PcmLocalTasks.create) { msg("The New task form isn't available here."); return; }
    close();
    window.PcmLocalTasks.create(taskFor(c, item, days));
  }



  // ---------- Big chart, the way Search Console / Analytics draw it ----------
  // Smooth lines, a soft area under the first one, light gridlines with numbers, dates
  // along the bottom, the 28 days before as a dashed line, a second axis on the right for
  // a series on another scale (impressions), legend chips that hide / show a series, and a
  // crosshair with a tooltip for the day under the mouse.
  const bigReg = new Map();
  let bigSeq = 0;
  function niceMax(v) { if (!(v > 0)) return 1; const p = Math.pow(10, Math.floor(Math.log10(v))), f = v / p; return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p; }
  const short = (n) => (n >= 1e6 ? (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + "M" : n >= 1e3 ? (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + "K" : String(Math.round(n * 10) / 10));
  const dlab = (d) => { const x = new Date(d + "T12:00:00"); return isNaN(x) ? d : x.toLocaleDateString([], { month: "short", day: "numeric" }); };
  function smooth(pts, lo, hi) {
    if (pts.length < 2) return pts.length ? "M" + pts[0][0] + "," + pts[0][1] : "";
    let d = "M" + pts[0][0].toFixed(1) + "," + pts[0][1].toFixed(1);
    const cl = (v) => Math.max(lo, Math.min(hi, v));
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || p2, t = 0.18;
      d += " C" + (p1[0] + (p2[0] - p0[0]) * t).toFixed(1) + "," + cl(p1[1] + (p2[1] - p0[1]) * t).toFixed(1) + " " + (p2[0] - (p3[0] - p1[0]) * t).toFixed(1) + "," + cl(p2[1] - (p3[1] - p1[1]) * t).toFixed(1) + " " + p2[0].toFixed(1) + "," + p2[1].toFixed(1);
    }
    return d;
  }
  // o: { title, labels: [YYYY-MM-DD], series: [{ name, color, vals, prev, axis: "l"|"r", fmt }] }
  function bigChart(o) {
    const id = "bc" + (++bigSeq), W = 640, H = 230, PT = 14, PB = 28, PL = 46, n = o.labels.length;
    const hasR = o.series.some((x) => x.axis === "r"), PR = hasR ? 46 : 14;
    if (!n) return "";
    const max = {};
    for (const ax of ["l", "r"]) max[ax] = niceMax(Math.max(0, ...o.series.filter((x) => (x.axis || "l") === ax).flatMap((x) => (x.vals || []).concat(x.prev || []).filter((v) => v != null))));
    const X = (i) => PL + (n < 2 ? (W - PL - PR) / 2 : (i * (W - PL - PR)) / (n - 1)), Y = (v, ax) => PT + (1 - (Number(v) || 0) / max[ax]) * (H - PT - PB);
    let g = "";
    for (let k = 0; k <= 4; k++) {
      const yy = PT + (k * (H - PT - PB)) / 4;
      g += '<line x1="' + PL + '" x2="' + (W - PR) + '" y1="' + yy + '" y2="' + yy + '" class="bc-grid"/>';
      g += '<text x="' + (PL - 8) + '" y="' + yy + '" dy=".35em" text-anchor="end" class="bc-ax">' + short(max.l * (1 - k / 4)) + "</text>";
      if (hasR) g += '<text x="' + (W - PR + 8) + '" y="' + yy + '" dy=".35em" class="bc-ax">' + short(max.r * (1 - k / 4)) + "</text>";
    }
    const ticks = Math.min(6, n);
    for (let k = 0; k < ticks; k++) { const i = Math.round((k * (n - 1)) / Math.max(1, ticks - 1)); g += '<text x="' + X(i) + '" y="' + (H - 8) + '" text-anchor="middle" class="bc-ax">' + esc(dlab(o.labels[i])) + "</text>"; }
    let lines = "", defs = "";
    o.series.forEach((sr, si) => {
      const ax = sr.axis || "l", pts = (sr.vals || []).map((v, i) => [X(i), Y(v, ax)]);
      const path = smooth(pts, PT, H - PB);
      let grp = "";
      if (si === 0 && pts.length > 1) {
        defs += '<linearGradient id="' + id + "g" + si + '" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="' + sr.color + '" stop-opacity=".22"/><stop offset="1" stop-color="' + sr.color + '" stop-opacity="0"/></linearGradient>';
        grp += '<path d="' + path + " L" + pts[pts.length - 1][0].toFixed(1) + "," + (H - PB) + " L" + pts[0][0].toFixed(1) + "," + (H - PB) + ' Z" fill="url(#' + id + "g" + si + ')"/>';
      }
      if (sr.prev && sr.prev.length) {
        const pp = sr.prev.slice(-n).map((v, i) => [X(i + Math.max(0, n - sr.prev.length)), Y(v, ax)]);
        grp += '<path d="' + smooth(pp, PT, H - PB) + '" fill="none" stroke="' + sr.color + '" stroke-width="1.6" stroke-dasharray="4 4" opacity=".45" vector-effect="non-scaling-stroke"/>';
      }
      grp += '<path d="' + path + '" fill="none" stroke="' + sr.color + '" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>';
      lines += '<g data-s="' + si + '">' + grp + "</g>";
    });
    bigReg.set(id, { o, W, H, PT, PB, PL, PR, X, Y });
    const legend = o.series.map((sr, si) => '<button type="button" class="bc-leg on" data-s="' + si + '" style="--c:' + sr.color + '"><i></i>' + esc(sr.name) + "</button>").join("") + (o.series.some((x) => x.prev && x.prev.length) ? '<span class="bc-prevkey"><i></i>28 days before</span>' : "");
    return '<div class="bc" data-bc="' + id + '"><div class="bc-h"><b>' + esc(o.title) + '</b><span class="bc-legs">' + legend + "</span></div>" +
      '<div class="bc-wrap"><svg viewBox="0 0 ' + W + " " + H + '" class="bc-svg" role="img" aria-label="' + esc(o.title) + '"><defs>' + defs + "</defs>" + g + lines +
      '<line class="bc-cross" y1="' + PT + '" y2="' + (H - PB) + '" x1="0" x2="0" visibility="hidden"/><g class="bc-dots"></g><rect class="bc-hit" x="' + PL + '" y="' + PT + '" width="' + (W - PL - PR) + '" height="' + (H - PT - PB) + '" fill="transparent"/></svg><div class="bc-tip" hidden></div></div></div>';
  }
  function wireBig(root) {
    root.querySelectorAll(".bc").forEach((el) => {
      const r = bigReg.get(el.dataset.bc);
      if (!r) return;
      const svg = el.querySelector("svg"), tip = el.querySelector(".bc-tip"), cross = el.querySelector(".bc-cross"), dots = el.querySelector(".bc-dots"), n = r.o.labels.length;
      const off = new Set();
      el.querySelectorAll(".bc-leg").forEach((b) => { b.onclick = () => { const si = b.dataset.s; if (off.has(si)) off.delete(si); else if (off.size < r.o.series.length - 1) off.add(si); b.classList.toggle("on", !off.has(si)); el.querySelectorAll('g[data-s="' + si + '"]').forEach((gg) => gg.style.display = off.has(si) ? "none" : ""); }; });
      const hide = () => { tip.hidden = true; cross.setAttribute("visibility", "hidden"); dots.innerHTML = ""; };
      el.querySelector(".bc-hit").addEventListener("mousemove", (e) => {
        const b = svg.getBoundingClientRect(), mx = ((e.clientX - b.left) / b.width) * r.W;
        const i = Math.max(0, Math.min(n - 1, Math.round(((mx - r.PL) / (r.W - r.PL - r.PR)) * (n - 1))));
        const x = r.X(i);
        cross.setAttribute("x1", x); cross.setAttribute("x2", x); cross.setAttribute("visibility", "visible");
        let dh = "", th = '<div class="bc-tip-d">' + esc(new Date(r.o.labels[i] + "T12:00:00").toLocaleDateString([], { weekday: "short", month: "short", day: "numeric", year: "numeric" })) + "</div>";
        r.o.series.forEach((sr, si) => {
          if (off.has(String(si))) return;
          const v = (sr.vals || [])[i];
          if (v == null) return;
          dh += '<circle cx="' + x + '" cy="' + r.Y(v, sr.axis || "l") + '" r="4.5" fill="' + sr.color + '" stroke="#fff" stroke-width="2"/>';
          const pv = sr.prev && sr.prev.length ? sr.prev[i - (n - sr.prev.length)] : null;
          th += '<div><i style="background:' + sr.color + '"></i>' + esc(sr.name) + " <b>" + (sr.fmt || nf)(v) + "</b>" + (pv != null ? ' <span class="bc-tip-p">vs ' + (sr.fmt || nf)(pv) + "</span>" : "") + "</div>";
        });
        dots.innerHTML = dh; tip.innerHTML = th; tip.hidden = false;
        const px = (x / r.W) * b.width, w = tip.offsetWidth;
        tip.style.left = Math.max(0, Math.min(b.width - w, px + 14 > b.width - w ? px - w - 14 : px + 14)) + "px";
      });
      el.querySelector(".bc-hit").addEventListener("mouseleave", hide);
    });
  }
  // ---------- Search & traffic (Search Console + GA4, lib-gdata.js) ----------
  const pct = (a, b) => (b ? ((a - b) / b) * 100 : a ? 100 : 0);
  function delta(cur, prev, lowerBetter, fmtAbs) {
    if (prev == null || cur == null) return "";
    if (fmtAbs) { const d = cur - prev; if (Math.abs(d) < 0.05) return '<span class="sd-tr steady">→ same</span>'; const good = lowerBetter ? d < 0 : d > 0; return '<span class="sd-tr ' + (good ? "better" : "worse") + '">' + (d > 0 ? "▲ " : "▼ ") + fmtAbs(Math.abs(d)) + "</span>"; }
    const p = pct(cur, prev);
    if (Math.abs(p) < 2) return '<span class="sd-tr steady">→ ' + Math.round(p) + "%</span>";
    const good = lowerBetter ? p < 0 : p > 0;
    return '<span class="sd-tr ' + (good ? "better" : "worse") + '">' + (p > 0 ? "▲ " : "▼ ") + Math.abs(Math.round(p)) + "%</span>";
  }
  const nf = (n) => Math.round(Number(n) || 0).toLocaleString();
  function gdVerdict(r) {
    const out = [];
    if (r.gsc) { const p = pct(r.gsc.cur.clicks, r.gsc.prev.clicks); out.push([p, "Google search clicks " + (p >= 0 ? "up " : "down ") + Math.abs(Math.round(p)) + "%"]); }
    if (r.ga) { const p = pct(r.ga.cur.organic, r.ga.prev.organic); out.push([p, "organic visits " + (p >= 0 ? "up " : "down ") + Math.abs(Math.round(p)) + "%"]); }
    if (!out.length) return null;
    const avgp = out.reduce((a, x) => a + x[0], 0) / out.length;
    const k = avgp >= 5 ? "better" : avgp <= -10 ? "worse" : "steady";
    return { k, text: (k === "better" ? "Growing: " : k === "worse" ? "Dropping: " : "Holding steady: ") + out.map((x) => x[1]).join(", ") + " (last 28 days vs the 28 before)." + (k === "worse" ? " Check the top searches and pages below for what fell." : "") };
  }
  function gdBody(r, props, url) {
    const sel = (kind, list, cur, auto) => '<label class="sd-gdpick">' + (kind === "gsc" ? "Search Console" : "Analytics") + ' <select data-gd-pick="' + kind + '"><option value="__auto"' + (auto ? " selected" : "") + ">Automatic" + (auto && cur ? "" : auto ? " (none found)" : "") + "</option><option value=\"\"" + (!auto && !cur ? " selected" : "") + ">None</option>" +
      list.map((o) => '<option value="' + esc(o.v) + '"' + (o.t ? ' title="' + esc(o.t) + '"' : "") + (!auto && o.v === cur ? " selected" : "") + ">" + esc(o.l) + (auto && o.v === cur ? " (auto)" : "") + "</option>").join("") + "</select></label>";
    const pk = (r && r.pick) || (props && props.picks && props.picks[url]) || { gsc: "", ga: "", auto: { gsc: true, ga: true } };
    const pickers = props && props.ok ? '<div class="sd-gdpicks">' + sel("gsc", (props.gsc || []).map((x) => ({ v: x, l: x.replace(/^sc-domain:/, "Domain: "), t: "via " + ((props.gscAcct || {})[x] || "") })), pk.gsc, pk.auto && pk.auto.gsc) + sel("ga", (props.ga || []).map((x) => ({ v: x.id, l: x.name + " (" + x.account + ")", t: "via " + (x.acct || "") })), pk.ga, pk.auto && pk.auto.ga) + "</div>" : "";
    if (!r) return pickers + '<div class="sd-empty"><i class="sm-spin"></i> Loading Search Console and Analytics…</div>';
    if (!r.ok && /not connected/i.test(r.err || "")) return '<div class="sd-empty">Google data isn\'t set up yet. Easiest: whoever runs the team hub updates it (Admin › Team hub › Check the hub version) - then everyone sees it with no Google sign-in. Or connect your own Google account: Site monitor › Tools › 📈 Google data.</div>';
    if (!r.ok) return pickers + '<div class="sd-empty">Couldn\'t read it: ' + esc(r.err || "unknown") + ".</div>";
    const v = gdVerdict(r), g = r.gsc, a = r.ga, kpi = (lab, val, d, sub) => '<div class="sd-kpi"><span>' + lab + "</span><b>" + val + "</b><small>" + (d || "") + (sub ? " " + sub : "") + "</small></div>";
    let h = pickers + (v ? '<div class="sd-verdict ' + v.k + '">' + (v.k === "better" ? "📈 " : v.k === "worse" ? "📉 " : "➖ ") + esc(v.text) + "</div>" : "");
    if (!g && !a) h += '<div class="sd-empty">No Search Console or Analytics property is picked for this site. Pick them above (only properties your Google account can see are listed).</div>';
    h += '<div class="sd-kpis">';
    if (g) h += kpi("Clicks", nf(g.cur.clicks), delta(g.cur.clicks, g.prev.clicks), "from Google") + kpi("Impressions", nf(g.cur.imp), delta(g.cur.imp, g.prev.imp)) + kpi("Avg position", g.cur.pos != null ? g.cur.pos.toFixed(1) : "-", delta(g.cur.pos, g.prev.pos, true, (x) => x.toFixed(1))) + kpi("CTR", (g.cur.ctr * 100).toFixed(1) + "%", delta(g.cur.ctr, g.prev.ctr));
    if (a) h += kpi("Organic visits", nf(a.cur.organic), delta(a.cur.organic, a.prev.organic)) + kpi("All visits", nf(a.cur.sessions), delta(a.cur.sessions, a.prev.sessions)) + kpi("Users", nf(a.cur.users), delta(a.cur.users, a.prev.users)) + kpi("Key events", nf(a.cur.keyEvents), delta(a.cur.keyEvents, a.prev.keyEvents), "(leads, calls…)");
    h += "</div>";
    const col = (list, k) => (list || []).map((x) => x[k]);
    h += '<div class="bc-grid2">' + (g && g.daily.length ? bigChart({ title: "Google Search: clicks and impressions", labels: g.daily.map((x) => x.d), series: [
        { name: "Clicks", color: "#4285f4", vals: col(g.daily, "v"), prev: col(g.prevDaily, "v"), axis: "l" },
        { name: "Impressions", color: "#7b5cd6", vals: col(g.daily, "imp"), prev: col(g.prevDaily, "imp"), axis: "r" }] }) : "") +
      (a && a.daily.length ? bigChart({ title: "Analytics: visits", labels: a.daily.map((x) => x.d), series: [
        { name: "Organic visits", color: "#1a9e5a", vals: col(a.daily, "o"), prev: col(a.prevDaily, "o"), axis: "l" },
        { name: "All visits", color: "#f29900", vals: col(a.daily, "v"), prev: col(a.prevDaily, "v"), axis: "l" }] }) : "") + "</div>";
    if (g && (g.queries.length || g.pages.length)) h += '<div class="sd-cols"><div class="sd-todo"><b>Top searches (28 days)</b><table class="sd-tbl"><tr><th>Search</th><th>Clicks</th><th>Impr.</th><th>Pos.</th></tr>' + g.queries.map((q) => "<tr><td>" + esc(q.q) + "</td><td>" + nf(q.clicks) + "</td><td>" + nf(q.imp) + "</td><td>" + q.pos.toFixed(1) + "</td></tr>").join("") + "</table></div>" +
      '<div class="sd-facts"><b>Top pages from Google</b>' + g.pages.map((p) => '<div><span>' + nf(p.clicks) + " clicks</span>" + esc(p.p.replace(/^https?:\/\/[^/]+/, "") || "/") + "</div>").join("") + "</div></div>";
    if (r.errs && r.errs.length) h += '<div class="sd-chnote">' + esc(r.errs.join(" · ")) + "</div>";
    h += '<div class="sd-chnote">' + (r.cached ? "Saved " + ago(r.at) + " (refreshed every 12 hours)" : "Just read") + (g ? " · Search Console " + esc(g.range.cur[0]) + " to " + esc(g.range.cur[1]) + " (Google's data runs ~3 days behind)" : "") + "</div>";
    return h;
  }
  async function loadGd(boxEl, c, force) {
    const host = boxEl.querySelector("[data-gd]");
    if (!host) return;
    const my = gen, paint = (r, props) => { if (my !== gen || !host.isConnected) return; if (r && r.ok) c._gd = r; host.querySelector(".sd-gd-b").innerHTML = gdBody(r, props, c.site.url); wire(props); wireBig(host); };
    let props = null;
    const wire = (p) => host.querySelectorAll("[data-gd-pick]").forEach((sl) => { sl.onchange = async () => {
      const kind = sl.dataset.gdPick, v = sl.value;
      await chrome.runtime.sendMessage({ type: "GDATA_SET_MAP", url: c.site.url, [kind]: v === "__auto" ? null : v }).catch(() => {});
      paint(null, p); const r2 = await chrome.runtime.sendMessage({ type: "GDATA_REPORT", url: c.site.url, force: true }).catch(() => null); paint(r2, p);
    }; });
    paint(null, null);
    props = await chrome.runtime.sendMessage({ type: "GDATA_PROPS", urls: [c.site.url] }).catch(() => null);
    paint(null, props);
    const r = await chrome.runtime.sendMessage({ type: "GDATA_REPORT", url: c.site.url, force: !!force }).catch(() => null);
    paint(r || { ok: false, err: "no answer" }, props);
  }

  // ---------- Client Wins: the best HONEST positive comparison for a monthly report ----------
  // Rules (owner, 2026-11-28): complete calendar months only; tiers 1-month -> 2-month ->
  // quarter, each vs the previous period AND the same period last year; the headline
  // metric (organic leads) is tried in every tier first, supporting metrics only when the
  // headline is positive nowhere; positive only, counts not percentages, exact dates on
  // every win; a period with any month of missing data is "skipped: no data", never 0.
  const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const ymAdd = (ym, n) => { const [y, m] = ym.split("-").map(Number), t = y * 12 + (m - 1) + n; return Math.floor(t / 12) + "-" + String((t % 12) + 1).padStart(2, "0"); };
  const ymName = (ym, withYear) => MON[Number(ym.slice(5)) - 1] + (withYear ? " " + ym.slice(0, 4) : "");
  function perLabel(months, withYear) {
    const a = months[0], b = months[months.length - 1];
    if (months.length === 3 && (Number(a.slice(5)) - 1) % 3 === 0) return "Q" + ((Number(a.slice(5)) + 2) / 3) + (withYear ? " " + a.slice(0, 4) : "");
    if (months.length === 1) return ymName(a, withYear);
    return a.slice(0, 4) === b.slice(0, 4) ? ymName(a) + "–" + ymName(b, withYear) : ymName(a, true) + "–" + ymName(b, true);
  }
  // The periods for a given day: the current month is month to date (not final), never compared.
  function winPeriods(todayIso) {
    const cur = String(todayIso).slice(0, 7), last = ymAdd(cur, -1), lm = Number(last.slice(5));
    const qEnd = lm % 3 === 0 ? last : ymAdd(last, -(lm % 3));
    const span = (end, n) => Array.from({ length: n }, (_, i) => ymAdd(end, i - n + 1));
    const mk = (key, label, months) => ({ key, label, cur: months, prev: months.map((m) => ymAdd(m, -months.length)), yoy: months.map((m) => ymAdd(m, -12)) });
    const tiers = [mk("1m", "1-month", span(last, 1)), mk("2m", "2-month", span(last, 2)), mk("q", "Quarter", span(qEnd, 3))];
    const from = tiers.flatMap((t) => t.prev.concat(t.yoy)).sort()[0];
    return { current: cur, last, tiers, from };
  }
  const WIN_METRICS = [
    { k: "leadsOrg", src: "ga", label: "Organic leads", noun: "organic leads", sum: (o) => o.leadsOrg },
    { k: "leadsAll", src: "ga", label: "Leads (all sources)", noun: "leads", sum: (o) => o.leadsAll },
    { k: "orgSessions", src: "ga", label: "Organic visits", noun: "organic visits", sum: (o) => o.orgSessions },
    { k: "orgViews", src: "ga", label: "Google organic page views", noun: "organic page views", sum: (o) => o.orgViews },
    { k: "clicks", src: "gsc", label: "Google clicks", noun: "Google clicks", sum: (o) => o.clicks },
    { k: "imp", src: "gsc", label: "Google impressions", noun: "impressions", sum: (o) => o.imp },
    { k: "pos", src: "gsc", label: "Average position", noun: "average position", ratio: ["posw", "imp"], lower: true, dp: 1 },
    { k: "ctr", src: "gsc", label: "Click-through rate", noun: "click-through rate", ratio: ["clicks", "imp"], pct: true, dp: 2 },
    { k: "keyEvents", src: "ga", label: "Key events", noun: "key events", sum: (o) => o.keyEvents },
  ];
  // A metric over some months, or null when any month has no data for its source.
  function winValue(data, met, months, todayIso) {
    const src = data && data[met.src];
    if (!src) return null;
    const t = new Date(String(todayIso) + "T00:00:00Z");
    const gscCut = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() - 16, t.getUTCDate())).toISOString().slice(0, 7); // GSC keeps 16 months
    const gaFirst = met.src === "ga" ? Object.keys(src).filter((m) => (src[m].sessions || 0) > 0).sort()[0] : null;
    let a = 0, b = 0;
    for (const m of months) {
      const o = src[m];
      if (!o) return null;
      if (met.src === "gsc" && (m <= gscCut || !(o.days > 0))) return null;
      if (met.src === "ga" && (!(o.sessions > 0) || (m === gaFirst && data.from && m > data.from))) return null; // the property's first (partial) month
      if (met.ratio) { a += o[met.ratio[0]] || 0; b += o[met.ratio[1]] || 0; } else a += met.sum(o) || 0;
    }
    if (met.ratio) return b ? (met.pct ? (a / b) * 100 : a / b) : null;
    return a;
  }
  const winFmt = (met, v) => (met.dp != null ? v.toFixed(met.dp) + (met.pct ? "%" : "") : Math.round(v).toLocaleString());
  // Up / down / same on the DISPLAYED values, so rounding can never invent a direction.
  function winCompare(met, base, cur) {
    if (base == null || cur == null) return { st: "nodata" };
    const fa = winFmt(met, base), fb = winFmt(met, cur);
    if (fa === fb) return { st: "same", a: base, b: cur };
    const better = met.lower ? cur < base : cur > base;
    return { st: better ? "up" : "down", a: base, b: cur };
  }
  function winSentence(met, r, basePer, curPer) {
    const a = winFmt(met, r.a), b = winFmt(met, r.b);
    if (met.k === "pos") return "Average position improved from " + a + " in " + basePer + " to " + b + " in " + curPer + " (" + Math.abs(r.a - r.b).toFixed(1) + " places higher)";
    if (met.pct) return met.label + " rose from " + a + " in " + basePer + " to " + b + " in " + curPer + " (+" + (r.b - r.a).toFixed(2) + " points)";
    return met.label + " rose from " + a + " in " + basePer + " to " + b + " in " + curPer + " (+" + Math.round(r.b - r.a).toLocaleString() + ")";
  }
  function clientWins(data, todayIso) {
    const P = winPeriods(todayIso || (data && data.today) || new Date().toISOString().slice(0, 10));
    const grid = {}; // grid[metric][tier][kind] = compare result
    for (const met of WIN_METRICS) {
      grid[met.k] = {};
      for (const t of P.tiers) {
        const cv = winValue(data, met, t.cur, todayIso || data.today);
        grid[met.k][t.key] = { prev: winCompare(met, winValue(data, met, t.prev, todayIso || data.today), cv), yoy: winCompare(met, winValue(data, met, t.yoy, todayIso || data.today), cv), cur: cv };
      }
    }
    const kinds = ["prev", "yoy"], head = WIN_METRICS[0], support = WIN_METRICS.slice(1);
    const baseOf = (t, kind) => (kind === "prev" ? t.prev : t.yoy);
    const vsLabel = (t, kind) => perLabel(t.cur, true) + " vs " + perLabel(baseOf(t, kind), true);
    const mkWin = (met, t, kind) => ({ metric: met.k, tier: t.key, kind, period: vsLabel(t, kind), text: winSentence(met, grid[met.k][t.key][kind], perLabel(baseOf(t, kind), false), perLabel(t.cur, false)) });
    const notes = [];
    const headNote = (t) => t.label + " not positive (" + kinds.map((k) => { const r = grid[head.k][t.key][k]; return r.st === "nodata" ? "no " + perLabel(baseOf(t, k), true) + " data" : perLabel(t.cur, false) + " " + winFmt(head, r.b) + " vs " + perLabel(baseOf(t, k), false) + " " + winFmt(head, r.a) + " organic leads"; }).join("; ") + ").";
    let pick = null;
    for (const t of P.tiers) {
      const hk = kinds.filter((k) => grid[head.k][t.key][k].st === "up");
      if (hk.length) {
        const wins = hk.map((k) => mkWin(head, t, k));
        for (const met of support) {
          if (wins.length >= hk.length + 3) break;
          const k = hk.find((x) => grid[met.k][t.key][x].st === "up") || kinds.find((x) => grid[met.k][t.key][x].st === "up");
          if (k) wins.push(mkWin(met, t, k));
        }
        pick = { tier: t, wins, headline: true };
        break;
      }
      notes.push(headNote(t));
    }
    if (!pick) {
      if (!(data && data.ga)) notes.splice(0, notes.length, "No Analytics property, so no organic-lead comparison.");
      for (const t of P.tiers) {
        const wins = [];
        for (const met of support) {
          const k = kinds.find((x) => grid[met.k][t.key][x].st === "up");
          if (k && wins.length < 4) wins.push(mkWin(met, t, k));
        }
        if (wins.length) { pick = { tier: t, wins, headline: false }; break; }
      }
      if (pick) notes.push("Organic leads not positive in any tier - showing supporting metrics from the " + pick.tier.label.toLowerCase() + " tier.");
    }
    const mtd = {};
    for (const met of WIN_METRICS) { const src = data && data[met.src], o = src && src[P.current]; if (o) mtd[met.k] = met.ratio ? (o[met.ratio[1]] ? (met.pct ? (o[met.ratio[0]] / o[met.ratio[1]]) * 100 : o[met.ratio[0]] / o[met.ratio[1]]) : null) : met.sum(o); }
    return { periods: P, grid, pick, notes, mtd };
  }
  // At most ONE "$" a sentence (Google Docs turns text between two "$" into an equation).
  const oneDollar = (line) => { let seen = false; return line.replace(/\$/g, () => (seen ? "USD " : ((seen = true), "$"))); };
  function winsCopyText(name, w) {
    if (!w.pick) return "";
    return ["Client Wins - " + name + " (" + w.pick.tier.label.toLowerCase() + ": " + w.pick.wins[0].period + ")"].concat(w.pick.wins.map((x) => "- " + x.text + (x.period !== w.pick.wins[0].period ? " (" + x.period + ")" : ""))).map(oneDollar).join("\n");
  }
  function winsCard(c, data, all) {
    if (!data) return '<div class="sd-empty"><i class="sm-spin"></i> Working out this client\'s wins…</div>';
    if (!data.ok) return '<div class="sd-empty">' + esc(/not connected/i.test(data.err || "") ? "Needs Google data (Search & traffic above) first." : "Couldn't read the monthly numbers: " + (data.err || "unknown")) + "</div>";
    if ((data.errs || []).some((e) => /unknown action/i.test(e))) return '<div class="sd-empty">The data hub for this client needs a small update before it can give monthly numbers (copy the data hub script again from Admin › Team hub › Google data hubs and deploy a new version).</div>';
    const w = clientWins(data, data.today), P = w.periods;
    let h = "";
    if (w.pick) {
      h += '<div class="sd-wins-h">Client Wins - ' + esc(siteName(c)) + ' <span>(tier: ' + esc(w.pick.tier.label.toLowerCase()) + ", " + esc(w.pick.wins[0].period) + ")</span></div><ul class=\"sd-wins\">" +
        w.pick.wins.map((x) => '<li><span class="sd-win-ic">▲</span>' + esc(x.text) + (x.period !== w.pick.wins[0].period ? ' <small>(' + esc(x.period) + ")</small>" : "") + "</li>").join("") + "</ul>";
    } else {
      h += '<div class="sd-wins-none"><b>No positive comparison found this month.</b> <span>Internal only - nothing to send to the client.</span></div>';
    }
    const mtdBits = ["leadsOrg", "clicks", "orgSessions"].filter((k) => w.mtd[k] != null).map((k) => { const met = WIN_METRICS.find((m) => m.k === k); return winFmt(met, w.mtd[k]) + " " + met.noun; });
    const note = w.notes.concat(mtdBits.length ? ["Month to date (not final): " + mtdBits.join(", ") + "."] : []).concat((data.errs || []).length ? ["Errors: " + data.errs.join(" · ")] : []);
    if (note.length) h += '<div class="sd-wins-note" title="Internal - not in Copy for report">Internal: ' + esc(note.join(" ")) + "</div>";
    if (all || !w.pick) {
      const cell = (met, r) => r.st === "nodata" ? '<td class="nd">no data</td>' : '<td class="' + r.st + '">' + winFmt(met, r.a) + " → " + winFmt(met, r.b) + " " + (r.st === "up" ? "▲" : r.st === "down" ? "▼" : "=") + "</td>";
      h += '<div class="sd-wins-all"><table><tr><th>Metric</th>' + P.tiers.map((t) => "<th>" + esc(perLabel(t.cur, true)) + " vs " + esc(perLabel(t.prev, true)) + "</th><th>vs " + esc(perLabel(t.yoy, true)) + "</th>").join("") + "</tr>" +
        WIN_METRICS.map((met) => "<tr><td>" + esc(met.label) + "</td>" + P.tiers.map((t) => cell(met, w.grid[met.k][t.key].prev) + cell(met, w.grid[met.k][t.key].yoy)).join("") + "</tr>").join("") + "</table></div>";
    }
    return h;
  }
  async function loadWins(boxEl, c, force, all) {
    const host = boxEl.querySelector("[data-wins]");
    if (!host) return;
    const my = gen, body = host.querySelector(".sd-wins-b");
    const paint = (d) => { if (my !== gen || !host.isConnected) return; c._wins = d; body.innerHTML = winsCard(c, d, all); const cp = host.querySelector(".sd-wins-copy"); if (cp) cp.hidden = !(d && d.ok && clientWins(d, d.today).pick); };
    if (!force && c._wins && c._wins.ok) { paint(c._wins); return; }
    paint(null);
    const P = winPeriods(new Date().toISOString().slice(0, 10));
    const d = await chrome.runtime.sendMessage({ type: "GDATA_MONTHLY", url: c.site.url, from: P.from, force: !!force }).catch(() => null);
    paint(d || { ok: false, err: "no answer" });
  }
  let box = null, cur = null, curDays = [], gen = 0;
  function close() { gen++; cur = null; if (box) { box.remove(); box = null; } document.removeEventListener("keydown", onKey, true); }
  function onKey(e) { if (e.key === "Escape" && !document.querySelector(".lt-modal")) close(); }
  // New PageSpeed results (or a test starting / ending) redraw an open panel in place.
  try {
    chrome.storage.onChanged.addListener((ch, area) => {
      if (area !== "local" || !box || !cur || !(ch.sitePsi || ch.psiRunning)) return;
      const keep = box.querySelector(".sd-panel").scrollTop;
      chrome.storage.local.get("sitePsi").then((g) => { if (cur) open({ ...cur, ps: ((g.sitePsi || {})[cur.site.url]) || cur.ps }, keep); }).catch(() => {});
    });
  } catch (e) {}

  async function open(c, keepScroll) {
    const my = ++gen, wasOpen = !!box;
    cur = c;
    const sg = await chrome.storage.local.get(["siteHist", "psiKey", "psiRunning", "psiCfg", "gdataAuth", "gdataAccounts"]).catch(() => ({}));
    if (my !== gen) return; // closed (or redrawn again) while this one was reading
    const tuneWas = box && box.querySelector(".sd-tune:not([hidden])") ? box.querySelector(".sd-tune").dataset.dev || "mobile" : "";
    if (box) { box.remove(); box = null; }
    document.removeEventListener("keydown", onKey, true);
    const pc = sg.psiCfg || {}, runs = { all: Number(pc.runs) || 1, site: Number(pc.site && pc.site[c.site.url] && pc.site[c.site.url].runs) || 0 };
    const hist = (sg.siteHist || {})[c.site.url] || [];
    const running = !!(sg.psiRunning && Array.isArray(sg.psiRunning.urls) && sg.psiRunning.urls[0] === c.site.url && Date.now() - (Number(sg.psiRunning.at) || 0) < 5 * 60000) || !!c._testing;
    const days = series(hist), st = c.st || {};
    cur = c; curDays = days;
    const upAvg = avg(days.map((d) => d.up).filter((v) => v != null)), msAvg = avg(days.slice(-7).map((d) => d.ms).filter((v) => v != null));
    const dom = (c.ps && c.ps.dom) || (c.rec && c.rec.pageDom) || 0;
    const kb = c.rec && c.rec.pageKb, gz = c.rec && c.rec.pageGzKb, v = verdict(days);
    const tr = (key, low) => { const t = trend(days, key, low); return t ? '<span class="sd-tr ' + t.k + '">' + (t.k === "better" ? "▲ better" : t.k === "worse" ? "▼ worse" : "→ steady") + "</span>" : ""; };
    const kpi = (lab, val, sub, cls) => '<div class="sd-kpi ' + (cls ? "k-" + cls : "") + '"><span>' + lab + "</span><b>" + val + "</b><small>" + (sub || "") + "</small></div>";
    const status = st.paused ? ["paused", "⏸ Client paused"] : c.isOff ? ["off", "⏹ Monitoring off"] : st.up === true ? ["ok", "✅ Up"] : st.up === false ? ["bad", "🚨 Down"] : ["", "⚪ Not checked yet"];
    const tg = c.tags;
    const tagTxt = !tg ? "not read yet" : [tg.ga.length ? "GA ✓" : tg.gaUnknown ? "GA ?" : "GA ✗", tg.gtm.length || tg.gtmHand ? "GTM ✓" + (tg.gtm.length > 1 ? "×" + tg.gtm.length : "") : "GTM ✗", tg.clarity ? "Clarity ✓" : "Clarity ✗"].join(" · ");
    const lv = ["Fix now", "Soon", "Nice to have"], items = todo(c, days);
    box = document.createElement("div");
    box.className = "sd-back" + (wasOpen ? " sd-noanim" : "");
    box.innerHTML = '<div class="sd-panel" role="dialog" aria-label="' + esc(c.site.name || c.site.url) + '">' +
      '<div class="sd-head"><div><h3>' + esc(c.site.name || c.site.url) + '</h3><a href="' + esc(c.site.url) + '" target="_blank" rel="noopener" class="hint">' + esc(c.site.url) + ' ↗</a></div><span class="sd-st ' + status[0] + '">' + status[1] + '</span><span class="sd-sp"></span><span class="sd-msg" aria-live="polite"></span>' +
      '<button type="button" class="sd-export" title="Build the monthly client report as a Word file (.docx)">📄 Export report</button><span class="sd-sharewrap"><button type="button" class="sd-share" title="Share this site\'s report: open it as a page, save it as PDF or HTML, or copy it">🔗 Share ▾</button></span><button type="button" class="sd-check">Check now</button><button type="button" class="sd-x" title="Close (Esc)">✕</button></div>' +
      '<div class="sd-verdict ' + v.k + '">' + (v.k === "better" ? "📈 " : v.k === "worse" ? "📉 " : "➖ ") + esc(v.text) + "</div>" +
      perfCard(c.ps, !!sg.psiKey, running, runs) +
      '<div class="sd-gd" data-gd><div class="sd-perf-h"><span>SEARCH &amp; TRAFFIC</span><small>Google Search Console + Analytics 4</small><span class="sd-sp"></span><button type="button" class="sd-gdref" title="Read it again now">↻ Refresh</button></div><div class="sd-gd-b"></div></div>' +
      '<div class="sd-gd sd-winsbox" data-wins><div class="sd-perf-h"><span>CLIENT WINS</span><small>for the monthly report · complete months only</small><span class="sd-sp"></span><label class="sd-wins-allt" title="Every metric, every tier, up and down - for our own checks, never copied"><input type="checkbox" class="sd-wins-allc" /> All numbers (internal)</label><button type="button" class="sd-wins-copy" hidden title="Copies only the win sentences (plain text) for the client report">📋 Copy for report</button><button type="button" class="sd-winsref" title="Read the monthly numbers again">↻</button></div><div class="sd-wins-b"></div></div>' +
      '<div class="sd-kpis">' +
        kpi("Uptime", upAvg != null ? upAvg.toFixed(upAvg >= 99.95 ? 0 : 2) + "%" : "-", days.length ? "last " + days.length + " day" + (days.length === 1 ? "" : "s") + " " + tr("up", false) : "no history yet", upAvg != null && upAvg < 99 ? "bad" : "") +
        kpi("Reply time", msAvg != null ? msTxt(msAvg) : st.lastMs ? msTxt(st.lastMs) : "-", (msAvg != null ? "7-day average " : "last check ") + tr("ms", true), (msAvg || st.lastMs || 0) > 2000 ? "bad" : "") +
        kpi("Page size", kb ? kbTxt(kb) : "-", gz ? kbTxt(gz) + " sent (compressed)" : "HTML only", "") +
        kpi("DOM", dom ? dom.toLocaleString() : "-", "elements (under 1,500)", dom > 1500 ? "warn" : "") +
      "</div>" +
      '<div class="sd-charts">' +
        '<div class="sd-ch"><b>Uptime per day</b>' + chart(days, "up", { bars: true, min: 0, max: 100, fmt: (x) => x.toFixed(1) + "%", label: "Uptime per day" }) + "</div>" +
        '<div class="sd-ch"><b>Reply time</b>' + chart(days, "ms", { min: 0, goal: 2000, fmt: msTxt, label: "Reply time per day" }) + "</div>" +
        '<div class="sd-ch"><b>PageSpeed score (mobile)</b>' + chart(days, "score", { min: 0, max: 100, goal: 90, fmt: (x) => String(Math.round(x)), label: "PageSpeed score per day" }) + "</div>" +
        '<div class="sd-ch"><b>Page size</b>' + chart(days, "kb", { min: 0, fmt: kbTxt, label: "Page size per day" }) + "</div>" +
      "</div>" +
      '<div class="sd-cols"><div class="sd-todo"><div class="sd-todo-h"><b>What to do next</b>' + (items.some((t) => t[2]) ? '<button type="button" class="lnk sd-addall" title="One ClickUp task with every item below: the New task box opens filled in - pick the developer under Assignees and press Save &amp; apply to ClickUp">👤 Assign all to dev</button>' : "") + "</div>" +
        items.map((t, i) => '<div class="sd-item l' + t[0] + '"><span>' + lv[t[0]] + "</span><p>" + esc(t[1]) + "</p>" + (t[2] ? '<button type="button" class="lnk sd-add" data-i="' + i + '" title="Make a ClickUp task for this fix: the New task box opens filled in - pick the developer under Assignees and press Save &amp; apply to ClickUp">👤 Assign to dev</button>' : "") + "</div>").join("") + "</div>" +
      '<div class="sd-facts"><b>Setup</b>' +
        "<div><span>WordPress</span>" + esc((c.wz && c.wz.text) || "-") + "</div>" +
        "<div><span>PHP</span>" + esc((c.rec && c.pz && c.pz.text) || "not read yet") + "</div>" +
        "<div><span>Hosting</span>" + esc(c.hzName || "unknown") + "</div>" +
        "<div><span>Tags</span>" + esc(tagTxt) + "</div>" +
        (tg && tg.gtm.length ? "<div><span>GTM</span>" + esc(tg.gtm.join(", ")) + "</div>" : "") +
        "<div><span>Last check</span>" + (st.lastCheck ? esc(new Date(st.lastCheck).toLocaleString()) : "never") + "</div>" +
      "</div></div></div>";
    document.body.appendChild(box);
    if (keepScroll) box.querySelector(".sd-panel").scrollTop = keepScroll;
    const msgEl = box.querySelector(".sd-msg"), say = (t) => { msgEl.textContent = t; setTimeout(() => { if (msgEl.textContent === t) msgEl.textContent = ""; }, 4000); };
    box.addEventListener("mousedown", (e) => { if (e.target === box) close(); });
    box.querySelector(".sd-x").onclick = close;
    const chk = box.querySelector(".sd-check");
    chk.disabled = !!c.isOff;
    chk.onclick = () => { chk.disabled = true; chk.textContent = "Checking…"; if (c.onCheck) c.onCheck(); setTimeout(close, 600); };
    const exBtn = box.querySelector(".sd-export");
    if (exBtn) exBtn.onclick = () => { if (window.PcmReportExport && window.docx) window.PcmReportExport.open(c); else say("The report builder didn't load - reload the extension."); };
    const shareBtn = box.querySelector(".sd-share");
    shareBtn.onclick = () => shareMenu(shareBtn, c, days, say);
    box.querySelectorAll(".sd-add").forEach((b) => { b.onclick = () => addTask(c, items[Number(b.dataset.i)], days, say); });
    const all = box.querySelector(".sd-addall");
    if (all) all.onclick = () => {
      const real = items.filter((t) => t[2]);
      addTask(c, [Math.min(...real.map((t) => t[0])), real.map((t) => "- [" + lv[t[0]] + "] " + t[1]).join("\n"), "Site fixes (" + real.length + ")"], days, say);
    };
    { const wAll = box.querySelector(".sd-wins-allc"), wCopy = box.querySelector(".sd-wins-copy"), wRef = box.querySelector(".sd-winsref");
      loadWins(box, c, false, false);
      if (wAll) wAll.onchange = () => loadWins(box, c, false, wAll.checked);
      if (wRef) wRef.onclick = () => loadWins(box, c, true, wAll && wAll.checked);
      if (wCopy) wCopy.onclick = async () => { try { await navigator.clipboard.writeText(winsCopyText(siteName(c), clientWins(c._wins, c._wins.today))); say("Wins copied - paste them into the report."); } catch (e) { say("Couldn't copy."); } };
    }
    loadGd(box, c, false); { const gr = box.querySelector(".sd-gdref"); if (gr) gr.onclick = () => loadGd(box, c, true); }
    const tb = box.querySelector(".sd-tunebtn"), tbox = box.querySelector(".sd-tune");
    if (tb && tbox) {
      tb.onclick = () => { tbox.hidden = !tbox.hidden; tb.classList.toggle("on", !tbox.hidden); if (!tbox.hidden) { tune(tbox, c.ps); tbox.scrollIntoView({ block: "nearest", behavior: "smooth" }); } };
      if (tuneWas) { tbox.dataset.dev = tuneWas; tbox.hidden = false; tb.classList.add("on"); tune(tbox, c.ps); }
    }
    const rs = box.querySelector(".sd-runsel");
    if (rs) rs.onchange = async () => {
      const g2 = (await chrome.storage.local.get("psiCfg")).psiCfg || {}, siteCfg = { ...(g2.site || {}) };
      if (rs.value) siteCfg[c.site.url] = { runs: Number(rs.value) }; else delete siteCfg[c.site.url];
      await chrome.storage.local.set({ psiCfg: { ...g2, site: siteCfg } });
      say("Saved - used from this site's next test (or Test now).");
    };
    const psiBtn = box.querySelector(".sd-psi");
    if (psiBtn) psiBtn.onclick = async () => {
      open({ ...c, _testing: true }, box.querySelector(".sd-panel").scrollTop);
      const r = await chrome.runtime.sendMessage({ type: "PSI_TEST_NOW", url: c.site.url }).catch(() => null);
      if (!cur || cur.site.url !== c.site.url) return;
      open({ ...c, _testing: false, ps: (r && r.psi) || c.ps }, box && box.querySelector(".sd-panel").scrollTop);
      if (r && !r.ok && box) box.querySelector(".sd-msg").textContent = r.error || "Couldn't test it - try again later.";
    };
    document.addEventListener("keydown", onKey, true);
  }
  window.PcmSiteDetail = { clientWins, winPeriods, winsCopyText, reportHtml, bigChart, open, close, series, trend, todo, verdict, ring, perfCard, report, taskFor, lhScore };
})();
