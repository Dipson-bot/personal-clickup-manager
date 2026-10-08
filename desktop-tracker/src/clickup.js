// ClickUp API for the desktop tracker (runs in the main process only; the
// window never sees the token). Mirrors what the extension does for its
// floating tracker: running timer, the task's estimate and time today, today's
// tasks, the recurring Extra Task, start / stop / complete, comments + files.
"use strict";

const API = "https://api.clickup.com/api/v2";
const DONE_RE = /^(closed|done|complete|completed|resolved|shipped|approved)$/i;
const EXTRA_RE = /\bextra(?:\(s\)|s)?\s+task(?:\(s\)|s)?\b/i;
const PRIO = { urgent: 0, high: 1, normal: 2, low: 3 };

class ClickUp {
  constructor(token) {
    this.token = token;
    this.userId = null;
    this.username = "";
    this.teamId = null;
    this.teams = [];
    this.extra = null; // { id, name, at }
    this.taskCache = new Map(); // id -> { at, t }
  }

  async req(path, opts = {}) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await fetch(API + path, {
        ...opts,
        headers: { Authorization: this.token, ...(opts.body && !(opts.body instanceof FormData) ? { "Content-Type": "application/json" } : {}), ...(opts.headers || {}) },
      });
      if (res.status === 429) {
        const wait = Math.min(60, Number(res.headers.get("retry-after")) || 15);
        await new Promise((z) => setTimeout(z, wait * 1000));
        continue;
      }
      const text = await res.text();
      let j = null;
      try { j = text ? JSON.parse(text) : null; } catch (e) {}
      if (!res.ok) {
        const e = new Error((j && (j.err || j.error)) || "ClickUp HTTP " + res.status);
        e.status = res.status;
        throw e;
      }
      return j;
    }
    throw new Error("ClickUp is busy (rate limit). Try again in a minute.");
  }

  // Check the token and pick the workspace (the saved one, else the first).
  async init(teamId) {
    const u = await this.req("/user");
    this.userId = u && u.user ? String(u.user.id) : null;
    this.username = (u && u.user && (u.user.username || u.user.email)) || "";
    const t = await this.req("/team");
    this.teams = ((t && t.teams) || []).map((x) => ({ id: String(x.id), name: x.name || "Workspace" }));
    this.teamId = (teamId && this.teams.some((x) => x.id === String(teamId)) ? String(teamId) : (this.teams[0] && this.teams[0].id)) || null;
    if (!this.teamId) throw new Error("This token has no ClickUp workspace.");
    return { userId: this.userId, username: this.username, teams: this.teams, teamId: this.teamId };
  }

  static dayBounds(now = Date.now()) {
    const s = new Date(now); s.setHours(0, 0, 0, 0);
    return { start: s.getTime(), end: s.getTime() + 86400000 - 1 };
  }

  async task(id, force) {
    const hit = this.taskCache.get(String(id));
    if (!force && hit && Date.now() - hit.at < 120000) return hit.t;
    const j = await this.req("/task/" + encodeURIComponent(id));
    const t = {
      id: String(j.id), name: j.name || "(task)", url: j.url || "https://app.clickup.com/t/" + j.id,
      estimateMs: Number(j.time_estimate) || 0, status: (j.status && j.status.status) || "",
      dueDateMs: j.due_date ? Number(j.due_date) : null, client: (j.list && j.list.name) || "",
      assigneeCount: Array.isArray(j.assignees) ? j.assignees.length : 0,
      description: String(j.text_content || j.description || "").trim(),
    };
    this.taskCache.set(String(id), { at: Date.now(), t });
    return t;
  }

  async running() {
    const j = await this.req("/team/" + this.teamId + "/time_entries/current");
    const d = j && j.data;
    if (!d || !d.task) return null;
    return { entryId: d.id != null ? String(d.id) : null, taskId: String(d.task.id), taskName: d.task.name || "", startMs: Number(d.start) || Date.now(), description: d.description || "" };
  }

  // My time entries today: total, and per task.
  async todayEntries() {
    const { start, end } = ClickUp.dayBounds();
    const j = await this.req("/team/" + this.teamId + "/time_entries?start_date=" + start + "&end_date=" + end + "&assignee=" + this.userId);
    const byTask = new Map();
    let total = 0;
    for (const e of (j && j.data) || []) {
      const dur = Number(e.duration) || 0;
      if (dur <= 0) continue; // the running one is added live
      total += dur;
      const id = e.task && e.task.id ? String(e.task.id) : "";
      if (id) byTask.set(id, (byTask.get(id) || 0) + dur);
    }
    return { total, byTask };
  }

  // Open tasks assigned to me that are due today (for "Next" suggestions).
  async dueToday() {
    const { start, end } = ClickUp.dayBounds();
    const j = await this.req("/team/" + this.teamId + "/task?subtasks=true&include_closed=false&assignees[]=" + this.userId +
      "&due_date_gt=" + (start - 1) + "&due_date_lt=" + (end + 1));
    return ((j && j.tasks) || [])
      .filter((t) => !DONE_RE.test(String((t.status && t.status.status) || "")) && !EXTRA_RE.test(t.name || "") && (t.assignees || []).length <= 1)
      .map((t) => ({ id: String(t.id), name: t.name || "(task)", prio: PRIO[String((t.priority && t.priority.priority) || "").toLowerCase()] ?? 4, due: Number(t.due_date) || 0, client: (t.list && t.list.name) || "" }))
      .sort((a, b) => a.prio - b.prio || a.due - b.due);
  }

  // The recurring "Extra Task(s)" assigned to me (looked up once an hour).
  async extraTask() {
    if (this.extra && Date.now() - this.extra.at < 3600000) return this.extra;
    let found = null;
    for (let page = 0; page < 3 && !found; page++) {
      const j = await this.req("/team/" + this.teamId + "/task?page=" + page + "&subtasks=true&include_closed=false&assignees[]=" + this.userId);
      const tasks = (j && j.tasks) || [];
      const hit = tasks.filter((t) => EXTRA_RE.test(t.name || "")).sort((a, b) => (Number(a.due_date) || 9e15) - (Number(b.due_date) || 9e15))[0];
      if (hit) found = { id: String(hit.id), name: hit.name };
      if (tasks.length < 100) break;
    }
    this.extra = { ...(found || { id: null, name: "" }), at: Date.now() };
    return this.extra;
  }

  async setStatus(taskId, status) {
    await this.req("/task/" + encodeURIComponent(taskId), { method: "PUT", body: JSON.stringify({ status }) });
    this.taskCache.delete(String(taskId));
  }
  async stopTimer() { await this.req("/team/" + this.teamId + "/time_entries/stop", { method: "POST" }); }
  async startTimer(taskId, description) {
    const body = { tid: String(taskId) };
    if (description) body.description = String(description).slice(0, 500);
    await this.req("/team/" + this.teamId + "/time_entries/start", { method: "POST", body: JSON.stringify(body) });
  }
  async setEntryNote(entryId, description) {
    await this.req("/team/" + this.teamId + "/time_entries/" + encodeURIComponent(entryId), { method: "PUT", body: JSON.stringify({ description: String(description || "").slice(0, 500) }) });
  }

  async comments(taskId) {
    const j = await this.req("/task/" + encodeURIComponent(taskId) + "/comment");
    return ((j && j.comments) || []).map((c) => ({
      who: (c.user && (c.user.username || c.user.email)) || "Someone",
      userId: c.user && c.user.id != null ? String(c.user.id) : "",
      at: Number(c.date) || 0,
      text: (c.comment_text || (Array.isArray(c.comment) ? c.comment.map((x) => x.text || "").join("") : "") || "").trim(),
    })).filter((c) => c.text).sort((a, b) => b.at - a.at);
  }
  // Files go to the task as attachments (ClickUp can't put files in a comment),
  // then the comment lists them.
  async comment(taskId, text, files) {
    const links = [];
    for (const f of (files || []).slice(0, 10)) {
      const fd = new FormData();
      fd.append("attachment", new Blob([Buffer.from(f.b64 || "", "base64")], { type: f.type || "application/octet-stream" }), String(f.name || "file").slice(0, 120));
      const j = await this.req("/task/" + encodeURIComponent(taskId) + "/attachment", { method: "POST", body: fd });
      links.push((f.name || "file") + (j && j.url ? ": " + j.url : ""));
    }
    const body = [String(text || "").trim(), links.length ? "Attached: " + links.join("\n") : ""].filter(Boolean).join("\n\n");
    if (body) await this.req("/task/" + encodeURIComponent(taskId) + "/comment", { method: "POST", body: JSON.stringify({ comment_text: body.slice(0, 5000), notify_all: false }) });
  }
}

module.exports = { ClickUp, EXTRA_RE, DONE_RE };
