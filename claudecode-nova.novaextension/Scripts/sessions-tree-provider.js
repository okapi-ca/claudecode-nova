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
 */

const MAX_LINES_SCANNED = 500;
const PREVIEW_MAX_CHARS = 80;

class SessionsTreeProvider {
  constructor() {
    this._items = [];
    this._cache = Object.create(null);
  }

  refresh() {
    const workspacePath = nova.workspace.path;
    const dir = sessionDirForWorkspace();
    console.log("[sessions] refresh() — workspace.path=" + workspacePath + ", dir=" + dir);
    if (!dir) { this._items = []; return; }

    let entries;
    try { entries = nova.fs.listdir(dir); }
    catch (err) {
      console.log("[sessions] listdir(" + dir + ") failed: " + (err && err.message));
      this._items = [];
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
    this._items = records;
  }

  getChildren(element) {
    if (!element) return this._items;
    return [];
  }

  getTreeItem(element) {
    const label = element.preview || "(empty session)";
    const item = new TreeItem(label);
    item.identifier = element.sessionId;
    // Surface the branch inline next to the time — disambiguates sessions
    // when the user has many on the same workspace across feature branches.
    item.descriptiveText = element.gitBranch
      ? element.gitBranch + "  ·  " + relativeTime(element.mtimeMs)
      : relativeTime(element.mtimeMs);

    const tooltipLines = [];
    tooltipLines.push("Session: " + element.sessionId);
    if (element.gitBranch) tooltipLines.push("Branch: " + element.gitBranch);
    tooltipLines.push("Last activity: " + new Date(element.mtimeMs).toLocaleString());
    tooltipLines.push("Click to choose where to resume (chat / CLI panel / terminal / clipboard).");
    item.tooltip = tooltipLines.join("\n");

    item.image = "__builtin.path.action";
    item.command = "claudecode.resumeSession";
    return item;
  }
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
