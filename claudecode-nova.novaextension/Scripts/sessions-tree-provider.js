/**
 * sessions-tree-provider.js — TreeDataProvider for the "Recent Sessions"
 * sidebar section. Lists Claude Code session files for the current workspace
 * (~/.claude/projects/<encoded-cwd>/*.jsonl) sorted by mtime desc, with a
 * preview of the first real user message. Clicking an item invokes
 * `claudecode.resumeSession`, which copies `<claudeCommand> --resume <id>`
 * to the clipboard.
 *
 * Per-session preview parsing is cached by mtime so reload() over an
 * unchanged dir doesn't re-read 30+ jsonl files.
 *
 * Live state: the constructor takes a getter returning S.claudeSessions (fed
 * by hooks.js from Claude Code's hooks). Sessions that are alive right now
 * float to the top with a state glyph (working / waiting / idle / error);
 * a live session whose .jsonl has not appeared on disk yet is listed too.
 */

const MAX_LINES_SCANNED = 500;
const PREVIEW_MAX_CHARS = 80;

const STATE_GLYPH = { working: "🟢", waiting: "🟠", idle: "⚪", error: "🔴" };
const STATE_LABEL = { working: "working", waiting: "waiting for you", idle: "idle", error: "failed" };
// Sort rank for live sessions: the one that needs a human comes first.
const STATE_RANK = { waiting: 0, error: 1, working: 2, idle: 3 };

class SessionsTreeProvider {
  constructor(getLiveSessions) {
    this._items = [];
    this._cache = Object.create(null);
    this._getLive = typeof getLiveSessions === "function" ? getLiveSessions : function() { return {}; };
  }

  refresh() {
    const workspacePath = nova.workspace.path;
    const dir = sessionDirForWorkspace();
    console.log("[sessions] refresh() — workspace.path=" + workspacePath + ", dir=" + dir);
    const live = this._getLive() || {};
    if (!dir) { this._items = mergeLive([], live); return; }

    let entries;
    try { entries = nova.fs.listdir(dir); }
    catch (err) {
      console.log("[sessions] listdir(" + dir + ") failed: " + (err && err.message));
      this._items = mergeLive([], live);
      return;
    }
    console.log("[sessions] listdir returned " + entries.length + " entries; "
      + entries.filter(n => n.endsWith(".jsonl")).length + " jsonl");

    const records = [];
    for (const name of entries) {
      if (!name.endsWith(".jsonl")) continue;
      const sessionId = name.slice(0, -".jsonl".length);
      const full = dir + "/" + name;

      let stat;
      try { stat = nova.fs.stat(full); }
      catch (_) { continue; }
      if (!stat) continue;

      const mtimeMs = stat.mtime instanceof Date
        ? stat.mtime.getTime()
        : Number(stat.mtime) || 0;

      const cached = this._cache[sessionId];
      let preview, gitBranch;
      if (cached && cached.mtimeMs === mtimeMs) {
        preview = cached.preview;
        gitBranch = cached.gitBranch;
      } else {
        const parsed = readFirstUserMessage(full);
        preview = parsed.preview;
        gitBranch = parsed.gitBranch;
        this._cache[sessionId] = { mtimeMs, preview, gitBranch };
      }

      records.push({ sessionId, mtimeMs, preview, gitBranch });
    }

    records.sort((a, b) => b.mtimeMs - a.mtimeMs);
    this._items = mergeLive(records, live);
  }

  getChildren(element) {
    if (!element) return this._items;
    return [];
  }

  getTreeItem(element) {
    const live = element.live || null;
    const preview = element.preview || (live ? "(session in progress)" : "(empty session)");
    const label = live ? (STATE_GLYPH[live.state] || "⚪") + "  " + preview : preview;
    const item = new TreeItem(label);
    item.identifier = element.sessionId;
    // Surface the branch inline next to the time — disambiguates sessions
    // when the user has many on the same workspace across feature branches.
    // Live sessions lead with their state (and the tool they are running).
    const when = element.gitBranch
      ? element.gitBranch + "  ·  " + relativeTime(element.mtimeMs)
      : relativeTime(element.mtimeMs);
    if (live) {
      const state = (STATE_LABEL[live.state] || live.state) + (live.tool ? " · " + live.tool : "");
      item.descriptiveText = state + "  ·  " + when;
    } else {
      item.descriptiveText = when;
    }

    const tooltipLines = [];
    tooltipLines.push("Session: " + element.sessionId);
    if (live) {
      tooltipLines.push("State: " + (STATE_LABEL[live.state] || live.state) + (live.tool ? " (" + live.tool + ")" : ""));
      if (live.model) tooltipLines.push("Model: " + live.model);
      if (live.permissionMode) tooltipLines.push("Permission mode: " + live.permissionMode);
      if (live.fromChat) tooltipLines.push("Driven from the Nova chat panel");
      if (live.lastError) tooltipLines.push("Last error: " + live.lastError);
      else if (live.lastMessage) tooltipLines.push("Last reply: " + live.lastMessage);
    }
    if (element.gitBranch) tooltipLines.push("Branch: " + element.gitBranch);
    tooltipLines.push("Last activity: " + new Date(element.mtimeMs).toLocaleString());
    tooltipLines.push("Click to choose where to resume (chat / CLI panel / terminal / clipboard).");
    item.tooltip = tooltipLines.join("\n");

    item.image = "__builtin.path.action";
    item.command = "claudecode.resumeSession";
    return item;
  }
}

// Attach live state to on-disk records, add live sessions that have no
// .jsonl yet, and float live ones to the top (waiting first, then by
// recency). Non-live records keep their mtime order.
function mergeLive(records, live) {
  const seen = Object.create(null);
  const out = [];
  for (const r of records) {
    seen[r.sessionId] = true;
    const l = live[r.sessionId];
    out.push(l ? Object.assign({}, r, { live: l, mtimeMs: Math.max(r.mtimeMs, l.updatedAt || 0) }) : r);
  }
  for (const id of Object.keys(live)) {
    if (seen[id]) continue;
    const l = live[id];
    out.push({ sessionId: id, mtimeMs: l.updatedAt || Date.now(), preview: "", gitBranch: null, live: l });
  }
  out.sort((a, b) => {
    if (!!a.live !== !!b.live) return a.live ? -1 : 1;
    if (a.live && b.live) {
      const ra = STATE_RANK[a.live.state] ?? 9, rb = STATE_RANK[b.live.state] ?? 9;
      if (ra !== rb) return ra - rb;
    }
    return b.mtimeMs - a.mtimeMs;
  });
  return out;
}

function sessionDirForWorkspace() {
  const workspace = nova.workspace.path;
  if (!workspace) return null;
  const home = nova.environment["HOME"];
  if (!home) return null;
  // Claude Code encodes the absolute cwd into a single directory name by
  // replacing every "/" with "-" (so the leading slash becomes a leading "-").
  const encoded = workspace.replace(/\//g, "-");
  return home + "/.claude/projects/" + encoded;
}

// Read the JSONL line-by-line and return the first message of type "user"
// whose extracted text isn't a slash-command caveat. Also captures the
// gitBranch seen on the first event that exposes it.
function readFirstUserMessage(filepath) {
  let file;
  try { file = nova.fs.open(filepath, "r"); }
  catch (_) { return { preview: "", gitBranch: null }; }

  let preview = "";
  let gitBranch = null;
  try {
    let scanned = 0;
    while (scanned++ < MAX_LINES_SCANNED) {
      const line = file.readline();
      if (line === null || line === undefined || line === "") break;

      let obj;
      try { obj = JSON.parse(line); }
      catch (_) { continue; }

      if (!gitBranch && typeof obj.gitBranch === "string" && obj.gitBranch) {
        gitBranch = obj.gitBranch;
      }
      if (obj.type !== "user") continue;

      const text = extractText(obj);
      if (!text) continue;
      // Skip Claude Code internal caveats injected by slash commands.
      if (text.startsWith("<local-command") || text.startsWith("<command-")) continue;

      preview = truncate(text.replace(/\s+/g, " ").trim(), PREVIEW_MAX_CHARS);
      break;
    }
  } finally {
    try { file.close(); } catch (_) {}
  }
  return { preview, gitBranch };
}

function extractText(userEvent) {
  const msg = userEvent.message;
  if (!msg) return "";
  const content = msg.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    for (const c of content) {
      if (!c || typeof c !== "object") continue;
      if (typeof c.text === "string") return c.text;
    }
  }
  return "";
}

function truncate(s, n) {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}

function relativeTime(ts) {
  const diff = (Date.now() - ts) / 1000;
  if (diff < 5) return "just now";
  if (diff < 60) return Math.floor(diff) + "s ago";
  if (diff < 3600) return Math.floor(diff / 60) + "m ago";
  if (diff < 86400) return Math.floor(diff / 3600) + "h ago";
  if (diff < 86400 * 30) return Math.floor(diff / 86400) + "d ago";
  return new Date(ts).toLocaleDateString();
}

module.exports = { SessionsTreeProvider, sessionDirForWorkspace };
