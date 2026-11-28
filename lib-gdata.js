// Google data for Site monitor: each client's Search Console and Google Analytics 4,
// read-only, with the user's own Google sign-ins - SEVERAL accounts can be connected
// (clients split across Google accounts). Used by a site's page (site-detail.js) for its
// Search & traffic card: last 28 days against the 28 before, daily lines, top searches.
//
// Sign-in: GDATA_CLIENT_ID below. Its project needs the Google Search Console API, the Google Analytics Data API and
// the Google Analytics Admin API turned on, and the two read-only scopes below on its
// OAuth consent screen. Tokens last an hour and are renewed silently (login_hint).
//
// storage gdataAccounts [{ email, token, expiresAt }] (was gdataAuth, one account),
// gdataProps { at, gsc: [siteUrl], gscAcct: { siteUrl: email }, ga: [{ id, name, account,
// uris, acct }] }, gdataMap { [siteUrl]: { gsc, ga } } (picked by hand), gdataCache
// { [siteUrl]: { at, gsc, ga, err } } (kept 12 hours).
import { launchAuth } from "./lib-drive.js";
// Its own Google client (the company Google Cloud project): Search Console API,
// Analytics Data API and Analytics Admin API on; consent screen External / Testing with
// the read-only scopes below; redirect https://<extension id>.chromiumapp.org/.
const GDATA_CLIENT_ID = "615908688836-tdgdsoea1mjdr07nsqk533u2rbd38394.apps.googleusercontent.com";

const SCOPES = "https://www.googleapis.com/auth/webmasters.readonly https://www.googleapis.com/auth/analytics.readonly openid email";
const CACHE_MS = 12 * 3600000;
const PROPS_MS = 24 * 3600000;

export async function gdataAccounts() {
  const g = await chrome.storage.local.get(["gdataAccounts", "gdataAuth"]);
  if (Array.isArray(g.gdataAccounts)) return g.gdataAccounts;
  const list = g.gdataAuth && g.gdataAuth.email ? [g.gdataAuth] : []; // the one-account version
  await chrome.storage.local.set({ gdataAccounts: list });
  await chrome.storage.local.remove("gdataAuth");
  return list;
}
async function saveAccount(acc) {
  const list = (await gdataAccounts()).filter((a) => a.email !== acc.email);
  list.push(acc);
  await chrome.storage.local.set({ gdataAccounts: list });
}
// A fresh token for one connected account (renewed silently), or null.
export async function gdataToken(email) {
  const now = Date.now(), a = (await gdataAccounts()).find((x) => x.email === email);
  if (!a) return null;
  if (a.token && a.expiresAt > now + 60000) return a.token;
  const r = await launchAuth({ interactive: false, scope: SCOPES, clientId: GDATA_CLIENT_ID, loginHint: email });
  if (!r || !r.token) return null;
  await saveAccount({ email, token: r.token, expiresAt: now + (r.expiresIn - 60) * 1000 });
  return r.token;
}
// Connect another Google account (Google's own account picker and consent window).
export async function gdataConnect() {
  const now = Date.now();
  const r = await launchAuth({ interactive: true, scope: SCOPES, clientId: GDATA_CLIENT_ID, prompt: "select_account consent" });
  if (!r || !r.token) return null;
  let email = "";
  try { const u = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", { headers: { Authorization: "Bearer " + r.token } }); if (u.ok) email = String((await u.json()).email || ""); } catch (e) {}
  if (!email) return null;
  await saveAccount({ email, token: r.token, expiresAt: now + (r.expiresIn - 60) * 1000 });
  return email;
}
// Disconnect one account (or all when no email is given).
export async function gdataDisconnect(email) {
  const list = await gdataAccounts(), gone = list.filter((a) => !email || a.email === email);
  for (const a of gone) if (a.token) { try { await fetch("https://oauth2.googleapis.com/revoke?token=" + encodeURIComponent(a.token), { method: "POST" }); } catch (e) {} }
  await chrome.storage.local.set({ gdataAccounts: list.filter((a) => !gone.includes(a)) });
  await chrome.storage.local.remove(["gdataProps", "gdataCache"]);
}

async function gget(token, url, body) {
  const res = await fetch(url, body ? { method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" }, body: JSON.stringify(body) } : { headers: { Authorization: "Bearer " + token } });
  if (!res.ok) {
    let msg = "HTTP " + res.status;
    try { const j = await res.json(); msg = (j && j.error && (j.error.message || j.error.status)) || msg; } catch (e) {}
    const err = new Error(msg); err.status = res.status; throw err;
  }
  return res.json();
}

// The host a property or site is about: "example.com" for https://www.example.com/,
// sc-domain:example.com or a GA stream's default URI.
export function gdataHost(u) {
  const s = String(u || "").trim().replace(/^sc-domain:/i, "https://");
  try { return new URL(/^https?:\/\//i.test(s) ? s : "https://" + s).hostname.replace(/^www\./i, "").toLowerCase(); } catch (e) { return ""; }
}

// Every Search Console property and GA4 property the connected accounts can see (once a
// day). A property both accounts can see is listed once (the first account reads it).
export async function gdataProps(force) {
  const { gdataProps: c } = await chrome.storage.local.get("gdataProps");
  if (!force && c && c.gscAcct && Date.now() - (c.at || 0) < PROPS_MS) return c;
  const accounts = await gdataAccounts();
  if (!accounts.length) throw new Error("not connected");
  const out = { at: Date.now(), gsc: [], gscAcct: {}, ga: [], errs: [], accounts: [] };
  for (const acc of accounts) {
    const token = await gdataToken(acc.email);
    if (!token) { out.errs.push(acc.email + ": sign in again (Connect)"); continue; }
    let nG = 0, nA = 0;
    try {
      const j = await gget(token, "https://www.googleapis.com/webmasters/v3/sites");
      for (const x of j.siteEntry || []) if (x && x.siteUrl && x.permissionLevel !== "siteUnverifiedUser" && !out.gscAcct[x.siteUrl]) { out.gsc.push(x.siteUrl); out.gscAcct[x.siteUrl] = acc.email; nG++; }
    } catch (e) { out.errs.push(acc.email + " Search Console: " + e.message); }
    try {
      let page = "", n = 0;
      const mine = [];
      do {
        const j = await gget(token, "https://analyticsadmin.googleapis.com/v1beta/accountSummaries?pageSize=200" + (page ? "&pageToken=" + encodeURIComponent(page) : ""));
        for (const a of j.accountSummaries || []) for (const p of a.propertySummaries || []) {
          const id = String(p.property || "").replace("properties/", "");
          if (!out.ga.some((x) => x.id === id)) mine.push({ id, name: String(p.displayName || ""), account: String(a.displayName || ""), uris: [], acct: acc.email });
        }
        page = j.nextPageToken || "";
      } while (page && ++n < 5);
      // Each property's website (its web data stream), to match it to a client's site.
      for (const p of mine.slice(0, 150)) {
        try { const j = await gget(token, "https://analyticsadmin.googleapis.com/v1beta/properties/" + p.id + "/dataStreams?pageSize=20"); p.uris = (j.dataStreams || []).map((d) => d.webStreamData && d.webStreamData.defaultUri).filter(Boolean); } catch (e) {}
      }
      out.ga.push(...mine); nA = mine.length;
    } catch (e) { out.errs.push(acc.email + " Analytics: " + e.message); }
    out.accounts.push({ email: acc.email, gsc: nG, ga: nA });
  }
  await chrome.storage.local.set({ gdataProps: out });
  return out;
}

// The properties for one site: picked by hand, else the one whose host matches.
export function gdataPick(siteUrl, props, map) {
  const m = (map && map[siteUrl]) || {}, host = gdataHost(siteUrl);
  const gsc = m.gsc !== undefined ? m.gsc : ((props.gsc || []).find((x) => x.startsWith("sc-domain:") && gdataHost(x) === host) || (props.gsc || []).find((x) => gdataHost(x) === host) || "");
  const ga = m.ga !== undefined ? m.ga : (((props.ga || []).find((p) => p.uris.some((u) => gdataHost(u) === host)) || {}).id || "");
  return { gsc, ga, auto: { gsc: m.gsc === undefined, ga: m.ga === undefined } };
}

const ymd = (d) => d.toISOString().slice(0, 10);
const daysAgo = (n) => { const d = new Date(); d.setUTCDate(d.getUTCDate() - n); return d; };
// Two 28-day periods; Search Console lags about 3 days, so it ends 3 days ago.
function periods(lag) { return { cur: [ymd(daysAgo(lag + 27)), ymd(daysAgo(lag))], prev: [ymd(daysAgo(lag + 55)), ymd(daysAgo(lag + 28))] }; }
const sum = (rows, k) => rows.reduce((a, r) => a + (Number(r[k]) || 0), 0);

async function gscReport(token, site) {
  const p = periods(3), base = "https://www.googleapis.com/webmasters/v3/sites/" + encodeURIComponent(site) + "/searchAnalytics/query";
  const daily = await gget(token, base, { startDate: p.prev[0], endDate: p.cur[1], dimensions: ["date"], rowLimit: 100 });
  const rows = (daily.rows || []).map((r) => ({ d: r.keys[0], clicks: r.clicks, imp: r.impressions, pos: r.position }));
  const inCur = rows.filter((r) => r.d >= p.cur[0]), inPrev = rows.filter((r) => r.d < p.cur[0]);
  const agg = (rs) => { const imp = sum(rs, "imp"), clicks = sum(rs, "clicks"); return { clicks, imp, ctr: imp ? clicks / imp : 0, pos: imp ? rs.reduce((a, r) => a + r.pos * r.imp, 0) / imp : null }; };
  const q = await gget(token, base, { startDate: p.cur[0], endDate: p.cur[1], dimensions: ["query"], rowLimit: 10 });
  const pg = await gget(token, base, { startDate: p.cur[0], endDate: p.cur[1], dimensions: ["page"], rowLimit: 5 });
  return { range: p, cur: agg(inCur), prev: agg(inPrev), daily: inCur.map((r) => ({ d: r.d, v: r.clicks, imp: r.imp, pos: r.pos })), prevDaily: inPrev.map((r) => ({ d: r.d, v: r.clicks, imp: r.imp })),
    queries: (q.rows || []).map((r) => ({ q: r.keys[0], clicks: r.clicks, imp: r.impressions, pos: r.position })),
    pages: (pg.rows || []).map((r) => ({ p: r.keys[0], clicks: r.clicks, imp: r.impressions })) };
}
async function gaReport(token, id) {
  const p = periods(1), url = "https://analyticsdata.googleapis.com/v1beta/properties/" + encodeURIComponent(id) + ":runReport";
  const mets = [{ name: "sessions" }, { name: "totalUsers" }, { name: "engagedSessions" }, { name: "keyEvents" }];
  const j = await gget(token, url, { dateRanges: [{ startDate: p.prev[0], endDate: p.cur[1] }], dimensions: [{ name: "date" }], metrics: mets, limit: 100 });
  const rows = (j.rows || []).map((r) => { const d = r.dimensionValues[0].value; return { d: d.slice(0, 4) + "-" + d.slice(4, 6) + "-" + d.slice(6), s: +r.metricValues[0].value, u: +r.metricValues[1].value, e: +r.metricValues[2].value, k: +r.metricValues[3].value }; }).sort((a, b) => (a.d < b.d ? -1 : 1));
  const o = await gget(token, url, { dateRanges: [{ startDate: p.prev[0], endDate: p.cur[1] }], dimensions: [{ name: "date" }], metrics: [{ name: "sessions" }], limit: 100,
    dimensionFilter: { filter: { fieldName: "sessionDefaultChannelGroup", stringFilter: { value: "Organic Search" } } } });
  const org = new Map((o.rows || []).map((r) => { const d = r.dimensionValues[0].value; return [d.slice(0, 4) + "-" + d.slice(4, 6) + "-" + d.slice(6), +r.metricValues[0].value]; }));
  for (const r of rows) r.o = org.get(r.d) || 0;
  const inCur = rows.filter((r) => r.d >= p.cur[0]), inPrev = rows.filter((r) => r.d < p.cur[0]);
  const agg = (rs) => { const s = sum(rs, "s"); return { sessions: s, users: sum(rs, "u"), organic: sum(rs, "o"), engaged: s ? sum(rs, "e") / s : 0, keyEvents: sum(rs, "k") }; };
  return { range: p, cur: agg(inCur), prev: agg(inPrev), daily: inCur.map((r) => ({ d: r.d, v: r.s, o: r.o, u: r.u })), prevDaily: inPrev.map((r) => ({ d: r.d, v: r.s, o: r.o })) };
}

// One site's report (cached 12 hours unless force). Never throws: errors come back in .err.
export async function gdataReport(siteUrl, force) {
  const g = await chrome.storage.local.get(["gdataCache", "gdataMap"]);
  const cache = g.gdataCache || {};
  if (!force && cache[siteUrl] && Date.now() - (cache[siteUrl].at || 0) < CACHE_MS) return { ...cache[siteUrl], cached: true };
  if (!(await gdataAccounts()).length) return { ok: false, err: "not connected" };
  let props;
  try { props = await gdataProps(false); } catch (e) { return { ok: false, err: e.message }; }
  const pick = gdataPick(siteUrl, props, g.gdataMap || {});
  const out = { ok: true, at: Date.now(), pick, gsc: null, ga: null, errs: [] };
  const tokFor = async (email) => { const t = email ? await gdataToken(email) : null; if (!t) throw new Error((email || "no connected account") + " needs to sign in again (Tools › Google data › Connect)"); return t; };
  if (pick.gsc) { try { out.gsc = await gscReport(await tokFor((props.gscAcct || {})[pick.gsc] || ((await gdataAccounts())[0] || {}).email), pick.gsc); } catch (e) { out.errs.push("Search Console: " + e.message); } }
  if (pick.ga) { try { out.ga = await gaReport(await tokFor(((props.ga || []).find((x) => x.id === pick.ga) || {}).acct || ((await gdataAccounts())[0] || {}).email), pick.ga); } catch (e) { out.errs.push("Analytics: " + e.message); } }
  const c2 = { ...((await chrome.storage.local.get("gdataCache")).gdataCache || {}) };
  c2[siteUrl] = out;
  for (const k of Object.keys(c2)) if (Date.now() - (c2[k].at || 0) > 7 * 86400000) delete c2[k];
  await chrome.storage.local.set({ gdataCache: c2 });
  return out;
}

// ---- Monthly numbers for Client Wins (same shape as team-hub.gs gdataMonthlyHub) ----
function monthRange(from) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(from || ""));
  const s = m ? new Date(Date.UTC(+m[1], +m[2] - 1, 1)) : daysAgo(480);
  return { start: ymd(s), end: ymd(new Date()) };
}
async function gscMonthly(token, site, from) {
  const r = monthRange(from), out = {};
  const j = await gget(token, "https://www.googleapis.com/webmasters/v3/sites/" + encodeURIComponent(site) + "/searchAnalytics/query", { startDate: r.start, endDate: r.end, dimensions: ["date"], rowLimit: 25000 });
  for (const x of j.rows || []) {
    const k = String(x.keys[0]).slice(0, 7), o = out[k] || (out[k] = { clicks: 0, imp: 0, posw: 0, days: 0 });
    o.clicks += x.clicks || 0; o.imp += x.impressions || 0; o.posw += (x.position || 0) * (x.impressions || 0); o.days++;
  }
  return out;
}
async function gaMonthly(token, id, from) {
  const r = monthRange(from), url = "https://analyticsdata.googleapis.com/v1beta/properties/" + encodeURIComponent(id) + ":runReport", out = {};
  const ym = (v) => String(v).slice(0, 4) + "-" + String(v).slice(4, 6);
  const get = (k) => out[k] || (out[k] = { leadsOrg: 0, leadsAll: 0, orgSessions: 0, orgViews: 0, keyEvents: 0, sessions: 0 });
  const range = [{ startDate: r.start, endDate: r.end }];
  const all = await gget(token, url, { dateRanges: range, dimensions: [{ name: "yearMonth" }], metrics: [{ name: "sessions" }, { name: "keyEvents" }], limit: 100 });
  for (const x of all.rows || []) { const o = get(ym(x.dimensionValues[0].value)); o.sessions += +x.metricValues[0].value; o.keyEvents += +x.metricValues[1].value; }
  const org = await gget(token, url, { dateRanges: range, dimensions: [{ name: "yearMonth" }], metrics: [{ name: "sessions" }, { name: "screenPageViews" }], limit: 100, dimensionFilter: { filter: { fieldName: "sessionDefaultChannelGroup", stringFilter: { value: "Organic Search" } } } });
  for (const x of org.rows || []) { const o = get(ym(x.dimensionValues[0].value)); o.orgSessions += +x.metricValues[0].value; o.orgViews += +x.metricValues[1].value; }
  const leads = await gget(token, url, { dateRanges: range, dimensions: [{ name: "yearMonth" }, { name: "sessionSourceMedium" }], metrics: [{ name: "eventCount" }], limit: 10000, dimensionFilter: { filter: { fieldName: "eventName", stringFilter: { value: "generate_lead", matchType: "EXACT" } } } });
  for (const x of leads.rows || []) {
    const o = get(ym(x.dimensionValues[0].value)), sm = String(x.dimensionValues[1].value || "").trim().toLowerCase(), n = +x.metricValues[0].value;
    if (/^tagassistant\.google\.com\s*\/\s*referral$/.test(sm)) continue;
    o.leadsAll += n;
    if (/\/\s*organic$/.test(sm)) { o.leadsOrg += n; o.srcOrg = o.srcOrg || {}; o.srcOrg[sm] = (o.srcOrg[sm] || 0) + n; }
  }
  return out;
}
export async function gdataMonthly(siteUrl, from, force, gaId) {
  const g = await chrome.storage.local.get(["gdataMonthCache", "gdataMap"]);
  const ck = siteUrl + "|" + from + (gaId ? "|" + gaId : ""), hit = (g.gdataMonthCache || {})[ck];
  if (!force && hit && Date.now() - (hit.at || 0) < CACHE_MS) return { ...hit, cached: true };
  if (!(await gdataAccounts()).length) return { ok: false, err: "not connected" };
  let props;
  try { props = await gdataProps(false); } catch (e) { return { ok: false, err: e.message }; }
  const pick = { ...gdataPick(siteUrl, props, g.gdataMap || {}), ...(gaId ? { ga: gaId } : {}) }, first = ((await gdataAccounts())[0] || {}).email;
  const tokFor = async (email) => { const t = email ? await gdataToken(email) : null; if (!t) throw new Error((email || "no connected account") + " needs to sign in again"); return t; };
  const out = { ok: true, at: Date.now(), from, today: ymd(new Date()), pick, gsc: null, ga: null, errs: [] };
  if (pick.gsc) { try { out.gsc = await gscMonthly(await tokFor((props.gscAcct || {})[pick.gsc] || first), pick.gsc, from); } catch (e) { out.errs.push("Search Console: " + e.message); } }
  if (pick.ga) { try { out.ga = await gaMonthly(await tokFor(((props.ga || []).find((x) => x.id === pick.ga) || {}).acct || first), pick.ga, from); } catch (e) { out.errs.push("Analytics: " + e.message); } }
  const c2 = { ...((await chrome.storage.local.get("gdataMonthCache")).gdataMonthCache || {}), [ck]: out };
  for (const k of Object.keys(c2)) if (Date.now() - (c2[k].at || 0) > 7 * 86400000) delete c2[k];
  await chrome.storage.local.set({ gdataMonthCache: c2 });
  return out;
}
