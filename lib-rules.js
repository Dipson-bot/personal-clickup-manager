// Automation rules: WHEN (a trigger) / IF (conditions) / THEN (actions).
// The building blocks, checking a rule, describing it in plain words, matching
// its conditions, the ready-made examples, and checking a rule an AI wrote.
// Plain script: loaded by options.html (the Automation tab, shown only after
// /automation) and imported by the background service worker, which runs the
// rules - so it only touches globalThis.
(() => {
  "use strict";
  const MIN = 60000;
  // ---------- the blocks ----------
  // f: the fields a block asks for. type: text | minutes | time | days | select.
  const TRIGGERS = {
    timer_started: { label: "A timer starts", task: true, f: [] },
    timer_stopped: { label: "A timer stops", task: true, f: [] },
    tracked_reaches: { label: "The running task reaches…", task: true, f: [
      { k: "what", type: "select", label: "", opts: { estimate: "its estimate", before: "N minutes before its estimate", time: "a set time tracked today" }, def: "estimate" },
      { k: "minutes", type: "minutes", label: "Minutes", def: 60, show: (p) => p.what !== "estimate" }] },
    task_completed: { label: "I complete a task", task: true, f: [] },
    task_due_today: { label: "A task is due today", task: true, f: [{ k: "hhmm", type: "time", label: "Check at", def: "09:00" }] },
    task_overdue: { label: "A task is overdue", task: true, f: [{ k: "hhmm", type: "time", label: "Check at", def: "09:30" }] },
    task_new: { label: "A new task lands in my lists", task: true, f: [] },
    time_of_day: { label: "It is a set time", task: false, f: [{ k: "hhmm", type: "time", label: "At", def: "16:30" }, { k: "days", type: "days", label: "On", def: [1, 2, 3, 4, 5] }] },
    site_down: { label: "A client's site goes down", site: true, f: [] },
    site_up: { label: "A client's site comes back up", site: true, f: [] },
    comment_mention: { label: "Someone mentions me in a comment", task: true, f: [] },
    task_archived: { label: "A task of mine is archived", task: true, f: [] },
  };
  const CONDS = {
    name_contains: { label: "Task name contains", f: [{ k: "text", type: "text", label: "", def: "" }] },
    name_starts: { label: "Task name starts with", f: [{ k: "text", type: "text", label: "", def: "Review" }] },
    name_not_contains: { label: "Task name does not contain", f: [{ k: "text", type: "text", label: "", def: "" }] },
    client_is: { label: "Client is", f: [{ k: "text", type: "text", label: "", def: "" }] },
    not_paused: { label: "The client is not paused", f: [] },
    status_is: { label: "Status is", f: [{ k: "status", type: "text", label: "", def: "in progress" }] },
    priority_is: { label: "Priority is", f: [{ k: "priority", type: "select", label: "", opts: { urgent: "Urgent", high: "High", normal: "Normal", low: "Low" }, def: "high" }] },
    has_estimate: { label: "The task has an estimate", f: [] },
    no_estimate: { label: "The task has no estimate", f: [] },
    over_estimate: { label: "The task is over its estimate", f: [] },
    no_proof: { label: "Nothing shows the work yet", tip: "Its File and Description fields are empty and there's no comment on it", f: [] },
    tracked_today_above: { label: "My tracked time today is above", f: [{ k: "minutes", type: "minutes", label: "", def: 420 }] },
    tracked_today_below: { label: "My tracked time today is below", f: [{ k: "minutes", type: "minutes", label: "", def: 420 }] },
    workday: { label: "It's a working day", tip: "Not a weekend or a company holiday", f: [] },
    time_between: { label: "The time is between", f: [{ k: "from", type: "time", label: "", def: "09:00" }, { k: "to", type: "time", label: "and", def: "17:00" }] },
  };
  // changes: it changes something in ClickUp (own-task check, approval, undo).
  const ACTIONS = {
    notify: { label: "Notify me", f: [{ k: "title", type: "text", label: "Title", def: "{task}" }, { k: "message", type: "text", label: "Message", def: "" }, { k: "sound", type: "select", label: "Sound", opts: { normal: "Normal chime", danger: "Alarm", none: "Silent" }, def: "normal" }] },
    stop_timer: { label: "Stop the timer", changes: true, f: [] },
    start_timer: { label: "Start the timer on", changes: true, f: [{ k: "which", type: "select", label: "", opts: { this: "this task", next_due: "the next task due today" }, def: "next_due" }] },
    complete_task: { label: "Mark the task complete", changes: true, task: true, f: [] },
    set_status: { label: "Set the status to", changes: true, task: true, f: [{ k: "status", type: "text", label: "", def: "in review" }] },
    move_due: { label: "Move the due date to", changes: true, task: true, f: [{ k: "to", type: "select", label: "", opts: { tomorrow: "tomorrow", next_workday: "the next working day", next_monday: "next Monday" }, def: "next_workday" }] },
    comment: { label: "Post a comment on the task", changes: true, task: true, f: [{ k: "text", type: "text", label: "", def: "" }] },
    open_task: { label: "Open the task in ClickUp", task: true, f: [] },
    open_url: { label: "Open a link", f: [{ k: "url", type: "text", label: "", def: "https://" }] },
    remind_open: { label: "Tell me what's still open", f: [{ k: "range", type: "select", label: "", opts: { today: "due today", week: "due this week", overdue: "overdue" }, def: "week" }] },
    wait: { label: "Wait", f: [{ k: "minutes", type: "minutes", label: "", def: 10 }] },
    // The weekly "Extra Tasks - <name>" in ClickUp (Mon-Fri, your weekly hours),
    // made by the extension instead of by hand. Nothing is made when this week
    // already has one, or when the whole week is office holidays.
    create_extra: { label: "Create this week's Extra Task", changes: true, f: [{ k: "hours", type: "select", label: "Hours a week",
      opts: { "5": "5h a week (1h a day)", "6": "6h a week (1h 12m a day)", "7": "7h a week (1h 24m a day)", "8": "8h a week (1h 36m a day)", "10": "10h a week (2h a day)", "15": "15h a week (3h a day)", "20": "20h a week (4h a day)" }, def: "7" }] },
  };
  const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const LIMITS = { perDay: 20, bulk: 3, maxConds: 6, maxActions: 6 };

  // ---------- cleaning a rule ----------
  const hhmm = (v, d) => (/^([01]?\d|2[0-3]):[0-5]\d$/.test(String(v || "")) ? String(v).padStart(5, "0") : d);
  function normParams(def, p) {
    const out = {};
    const src = p && typeof p === "object" ? p : {};
    for (const f of def.f || []) {
      let v = src[f.k];
      if (f.type === "minutes") { v = Math.round(Number(v)); if (!(v >= 1 && v <= 1440)) v = f.def; }
      else if (f.type === "time") v = hhmm(v, f.def);
      else if (f.type === "days") { v = [...new Set((Array.isArray(v) ? v : f.def).map(Number).filter((n) => n >= 0 && n <= 6))].sort(); if (!v.length) v = f.def.slice(); }
      else if (f.type === "select") v = f.opts[v] ? v : f.def;
      else v = String(v == null ? f.def : v).slice(0, 500);
      out[f.k] = v;
    }
    return out;
  }
  const uid = () => "r" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  // Any rule (saved, edited, from an example or an AI) through here first.
  // Returns { rule, dropped: ["…"] } - the blocks it couldn't keep, in words.
  function normRule(r) {
    const x = r && typeof r === "object" ? r : {};
    const dropped = [];
    const tt = x.trigger && TRIGGERS[x.trigger.type] ? x.trigger.type : "";
    if (!tt && x.trigger) dropped.push("the trigger “" + (x.trigger.type || "?") + "”");
    const conds = [];
    for (const c of Array.isArray(x.conds) ? x.conds : []) {
      if (c && CONDS[c.type]) conds.push({ type: c.type, params: normParams(CONDS[c.type], c.params) });
      else dropped.push("the condition “" + ((c && c.type) || "?") + "”");
    }
    const actions = [];
    for (const a of Array.isArray(x.actions) ? x.actions : []) {
      if (a && ACTIONS[a.type]) actions.push({ type: a.type, params: normParams(ACTIONS[a.type], a.params) });
      else dropped.push("the action “" + ((a && a.type) || "?") + "”");
    }
    const rule = {
      id: /^r[a-z0-9]{4,30}$/.test(String(x.id || "")) ? String(x.id) : uid(),
      name: String(x.name || "").trim().slice(0, 80),
      on: x.on !== false,
      trigger: tt ? { type: tt, params: normParams(TRIGGERS[tt], x.trigger.params) } : null,
      conds: conds.slice(0, LIMITS.maxConds),
      actions: actions.slice(0, LIMITS.maxActions),
      createdAt: Number(x.createdAt) || Date.now(),
      editedAt: Date.now(),
    };
    if (!rule.name) rule.name = rule.trigger ? TRIGGERS[tt].label : "New rule";
    return { rule, dropped };
  }
  // What stops a rule from being switched on: [] = fine.
  function problems(rule) {
    const out = [];
    if (!rule || !rule.trigger) out.push("Pick what starts it (WHEN).");
    if (!rule || !rule.actions || !rule.actions.length) out.push("Add at least one thing to do (THEN).");
    if (!rule || !rule.trigger) return out;
    const t = rule.trigger.type;
    const hasTask = !!TRIGGERS[t].task;
    for (const a of rule.actions) if (ACTIONS[a.type].task && !hasTask) out.push("“" + ACTIONS[a.type].label + "” needs a task, but “" + TRIGGERS[t].label + "” isn't about one.");
    for (const a of rule.actions) if (a.type === "start_timer" && a.params.which === "this" && !hasTask) out.push("“Start the timer on this task” needs a task to start.");
    // A rule whose actions wake its own trigger would run in a circle.
    const acts = new Set(rule.actions.map((a) => a.type));
    if (t === "timer_started" && (acts.has("start_timer") || acts.has("stop_timer"))) out.push("Starting or stopping the timer when a timer starts would set the rule off again and again.");
    if (t === "timer_stopped" && acts.has("stop_timer")) out.push("Stopping the timer when a timer stops does nothing.");
    if (t === "timer_stopped" && rule.actions.some((a) => a.type === "start_timer" && a.params.which === "this")) out.push("Starting the same task again whenever its timer stops would keep it running for ever.");
    if (rule.actions.length && rule.actions[rule.actions.length - 1].type === "wait") out.push("“Wait” at the end does nothing - put it between two actions.");
    return [...new Set(out)];
  }

  // ---------- describing a rule in plain words ----------
  const fmtMin = (m) => { m = Number(m) || 0; const h = Math.floor(m / 60), r = m % 60; return h ? h + "h" + (r ? " " + r + "m" : "") : r + "m"; };
  const fmtTime = (hm) => { const [h, m] = String(hm || "00:00").split(":").map(Number); return ((h + 11) % 12 + 1) + ":" + String(m).padStart(2, "0") + " " + (h >= 12 ? "PM" : "AM"); };
  const q = (s) => "“" + s + "”";
  function sayTrigger(t) {
    if (!t) return "(nothing picked yet)";
    const p = t.params || {};
    switch (t.type) {
      case "tracked_reaches": return p.what === "estimate" ? "the running task reaches its estimate" : p.what === "before" ? "the running task is " + fmtMin(p.minutes) + " from its estimate" : "the running task reaches " + fmtMin(p.minutes) + " tracked today";
      case "task_due_today": return "a task is due today (checked at " + fmtTime(p.hhmm) + ")";
      case "task_overdue": return "a task is overdue (checked at " + fmtTime(p.hhmm) + ")";
      case "time_of_day": {
        const d = (p.days || []).slice().sort();
        const days = d.join(",") === "1,2,3,4,5" ? "Monday to Friday" : d.length === 7 ? "every day" : "on " + d.map((n) => DAY_NAMES[n]).join(", ");
        return "it is " + fmtTime(p.hhmm) + " " + days;
      }
      default: return TRIGGERS[t.type].label.charAt(0).toLowerCase() + TRIGGERS[t.type].label.slice(1);
    }
  }
  function sayCond(c) {
    const p = c.params || {};
    switch (c.type) {
      case "name_contains": return "its name contains " + q(p.text);
      case "name_starts": return "its name starts with " + q(p.text);
      case "name_not_contains": return "its name doesn't contain " + q(p.text);
      case "client_is": return "the client is " + q(p.text);
      case "status_is": return "the status is " + q(p.status);
      case "priority_is": return "the priority is " + (CONDS.priority_is.f[0].opts[p.priority] || p.priority);
      case "tracked_today_above": return "I've tracked more than " + fmtMin(p.minutes) + " today";
      case "tracked_today_below": return "I've tracked less than " + fmtMin(p.minutes) + " today";
      case "time_between": return "it's between " + fmtTime(p.from) + " and " + fmtTime(p.to);
      default: return CONDS[c.type].label.charAt(0).toLowerCase() + CONDS[c.type].label.slice(1);
    }
  }
  function sayAction(a) {
    const p = a.params || {};
    switch (a.type) {
      case "notify": return "notify me" + (p.sound === "danger" ? " with the alarm" : "");
      case "start_timer": return p.which === "this" ? "start the timer on it" : "start the next task due today";
      case "complete_task": return "mark it complete";
      case "set_status": return "set its status to " + q(p.status);
      case "move_due": return "move its due date to " + ACTIONS.move_due.f[0].opts[p.to];
      case "create_extra": return "create this week's Extra Task (" + (ACTIONS.create_extra.f[0].opts[p.hours] || p.hours + "h a week") + ")";
      case "comment": return "post the comment " + q(String(p.text).slice(0, 60));
      case "open_url": return "open " + p.url;
      case "remind_open": return "tell me what's still open (" + ACTIONS.remind_open.f[0].opts[p.range] + ")";
      case "wait": return "wait " + fmtMin(p.minutes);
      default: return ACTIONS[a.type].label.charAt(0).toLowerCase() + ACTIONS[a.type].label.slice(1);
    }
  }
  const list = (xs, last) => xs.length < 2 ? xs[0] || "" : xs.slice(0, -1).join(", ") + " " + last + " " + xs[xs.length - 1];
  function describe(rule) {
    if (!rule) return "";
    let s = "When " + sayTrigger(rule.trigger);
    if (rule.conds && rule.conds.length) s += ", if " + list(rule.conds.map(sayCond), "and");
    s += ", then " + (rule.actions && rule.actions.length ? list(rule.actions.map(sayAction), "and") : "(nothing yet)");
    return s + ".";
  }

  // ---------- the conditions, against what happened ----------
  // ctx: { task: { id, name, client, status, priority, estimateMs, spentMs, paused },
  //        site: { name, url }, todayMs (tracked today), now, workday (bool),
  //        proofMissing (bool, worked out by the background only when asked) }
  const low = (s) => String(s == null ? "" : s).toLowerCase();
  const minsOf = (hm) => { const [h, m] = String(hm).split(":").map(Number); return h * 60 + m; };
  function condMet(c, ctx) {
    const t = ctx.task || null, p = c.params || {};
    const name = low(t ? t.name : ctx.site ? ctx.site.name : "");
    switch (c.type) {
      case "name_contains": return !!p.text && name.includes(low(p.text).trim());
      case "name_starts": return !!p.text && name.trim().startsWith(low(p.text).trim());
      case "name_not_contains": return !p.text || !name.includes(low(p.text).trim());
      case "client_is": { const cl = low(t ? t.client : ctx.site ? ctx.site.name : "").replace(/[^a-z0-9]+/g, ""); const w = low(p.text).replace(/[^a-z0-9]+/g, ""); return !!w && cl.includes(w); }
      case "not_paused": return !(t ? t.paused : ctx.site ? ctx.site.paused : false);
      case "status_is": return !!t && low(t.status).trim() === low(p.status).trim();
      case "priority_is": return !!t && low(t.priority) === low(p.priority);
      case "has_estimate": return !!t && Number(t.estimateMs) > 0;
      case "no_estimate": return !!t && !(Number(t.estimateMs) > 0);
      case "over_estimate": return !!t && Number(t.estimateMs) > 0 && Number(t.spentMs) > Number(t.estimateMs);
      case "no_proof": return ctx.proofMissing === true;
      case "tracked_today_above": return (Number(ctx.todayMs) || 0) > p.minutes * MIN;
      case "tracked_today_below": return (Number(ctx.todayMs) || 0) < p.minutes * MIN;
      case "workday": return ctx.workday !== false;
      case "time_between": { const d = new Date(ctx.now || Date.now()); const m = d.getHours() * 60 + d.getMinutes(); const a = minsOf(p.from), b = minsOf(p.to); return a <= b ? m >= a && m < b : m >= a || m < b; }
      default: return false;
    }
  }
  const condsMet = (rule, ctx) => (rule.conds || []).every((c) => condMet(c, ctx));
  // A task-only condition can't hold without a task (a time-of-day rule).
  const needsProofCheck = (rule) => (rule.conds || []).some((c) => c.type === "no_proof");

  // ---------- filling in the words ----------
  // {task} {client} {site} {url} {time} {estimate} {tracked}
  function fill(text, ctx) {
    const t = ctx.task || {}, s = ctx.site || {};
    return String(text || "").replace(/\{(task|client|site|url|time|estimate|tracked)\}/g, (m, k) => {
      if (k === "task") return t.name || s.name || "";
      if (k === "client") return t.client || s.name || "";
      if (k === "site") return s.name || s.url || "";
      if (k === "url") return t.url || s.url || "";
      if (k === "time") return new Date(ctx.now || Date.now()).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
      if (k === "estimate") return t.estimateMs ? fmtMin(Math.round(t.estimateMs / MIN)) : "no estimate";
      if (k === "tracked") return fmtMin(Math.round((Number(t.spentMs) || 0) / MIN));
      return m;
    }).trim();
  }

  // ---------- ready-made examples ----------
  const TEMPLATES = [
    { name: "Wrap up a review on time", why: "A review stops at its estimate, is marked complete, and the next task due today starts.",
      trigger: { type: "tracked_reaches", params: { what: "estimate" } }, conds: [{ type: "name_starts", params: { text: "Review" } }],
      actions: [{ type: "stop_timer" }, { type: "complete_task" }, { type: "start_timer", params: { which: "next_due" } }] },
    { name: "Heads-up before the estimate", why: "A nudge 10 minutes before a task runs out of its estimate.",
      trigger: { type: "tracked_reaches", params: { what: "before", minutes: 10 } }, conds: [],
      actions: [{ type: "notify", params: { title: "10 minutes left on {task}", message: "Estimate {estimate}, tracked {tracked} so far.", sound: "normal" } }] },
    { name: "Never forget the proof", why: "Completed a task with nothing showing the work? You get reminded to add the screenshot and closing comment.",
      trigger: { type: "task_completed" }, conds: [{ type: "no_proof" }],
      actions: [{ type: "notify", params: { title: "Add the proof for {task}", message: "No File, Description or comment on it yet - add the screenshot and a short closing comment.", sound: "danger" } }, { type: "open_task" }] },
    { name: "Client site down", why: "The alarm sound and the site opened, so you can see it at once.",
      trigger: { type: "site_down" }, conds: [{ type: "not_paused" }],
      actions: [{ type: "notify", params: { title: "{site} is down", message: "{url}", sound: "danger" } }, { type: "open_url", params: { url: "{url}" } }] },
    { name: "Friday tidy-up", why: "At 4:30 on Friday, what's still open this week, so nothing slips to Monday unnoticed.",
      trigger: { type: "time_of_day", params: { hhmm: "16:30", days: [5] } }, conds: [{ type: "workday" }],
      actions: [{ type: "remind_open", params: { range: "week" } }] },
    { name: "Weekly Extra Task", why: "For anyone whose Extra Task does NOT already repeat in ClickUp: the extension makes your Extra Tasks - <name> for each working week instead, Monday to Friday with your weekly hours (pick yours below). It checks at 8:00 AM on each working day (so a Monday off doesn't miss the week), makes nothing when that week already has one, and none for a week of holidays. If your Extra Task repeats in ClickUp, turn that repeat off first - switching this on warns you.",
      trigger: { type: "time_of_day", params: { hhmm: "08:00", days: [1, 2, 3, 4, 5] } }, conds: [{ type: "workday" }],
      actions: [{ type: "create_extra", params: { hours: "7" } }] },
    { name: "Someone needs me", why: "A mention opens the task straight away.",
      trigger: { type: "comment_mention" }, conds: [],
      actions: [{ type: "open_task" }] },
  ];

  // ---------- a rule an AI wrote ----------
  // The AI is told the block ids below and answers JSON; only real blocks survive.
  function catalogForAi() {
    const fields = (def) => (def.f || []).map((f) => f.k + (f.opts ? " (one of: " + Object.keys(f.opts).join(", ") + ")" : f.type === "time" ? " (HH:MM, 24h)" : f.type === "minutes" ? " (number of minutes)" : f.type === "days" ? " (list of weekday numbers, 0=Sun..6=Sat)" : " (text)")).join("; ");
    const part = (o) => Object.entries(o).map(([k, d]) => "- " + k + ": " + d.label + (d.f && d.f.length ? "  [params: " + fields(d) + "]" : "")).join("\n");
    return "TRIGGERS (exactly one):\n" + part(TRIGGERS) + "\n\nCONDITIONS (zero or more, all must hold):\n" + part(CONDS) +
      "\n\nACTIONS (one or more, done in order):\n" + part(ACTIONS) +
      "\n\nText fields may use {task}, {client}, {site}, {url}, {time}, {estimate}, {tracked}.";
  }
  const AI_SYSTEM = "You turn a person's sentence into ONE automation rule for a ClickUp time-tracking extension. " +
    "Use ONLY the block ids listed. Answer with JSON only, no prose, shaped exactly like: " +
    '{"name":"short name","trigger":{"type":"<id>","params":{}},"conds":[{"type":"<id>","params":{}}],"actions":[{"type":"<id>","params":{}}]}. ' +
    "If part of the sentence can't be done with these blocks, leave it out and add it to a field \"unplaced\" (a list of short phrases).";
  function fromAiText(text) {
    const s = String(text || "");
    const a = s.indexOf("{"), b = s.lastIndexOf("}");
    if (a < 0 || b <= a) return { error: "The AI didn't answer with a rule." };
    let obj;
    try { obj = JSON.parse(s.slice(a, b + 1)); } catch (e) { return { error: "The AI's answer couldn't be read as a rule." }; }
    const { rule, dropped } = normRule({ ...obj, on: false });
    const unplaced = (Array.isArray(obj.unplaced) ? obj.unplaced : []).map((x) => String(x).slice(0, 120)).filter(Boolean);
    return { rule, dropped, unplaced };
  }

  globalThis.PcmRules = { TRIGGERS, CONDS, ACTIONS, DAY_NAMES, LIMITS, TEMPLATES, normRule, problems, describe, sayTrigger, sayCond, sayAction, condMet, condsMet, needsProofCheck, fill, fmtMin, fmtTime, catalogForAi, AI_SYSTEM, fromAiText };
})();
