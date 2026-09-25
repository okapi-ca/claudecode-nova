// activity.js — Activity / tool-call logging, persistence to activity.json, diff stats + tooltip helpers.
//
// Split out of the former 3 500-line main.js (v0.28.0). Runs in Nova's
// JavaScriptCore runtime (CommonJS require, no Node built-ins). Nova's
// require() does NOT support circular dependencies (it recurses until
// "Maximum call stack size exceeded"), so modules never require each other:
// each one attaches its exports to the shared registry (R.<Name>) at the
// bottom, and cross-module calls dereference R.<Name>.fn at call time.

const S = require("./state.js");
const R = require("./registry.js");

function logActivity(type, data) {
  S.activityLog.unshift(Object.assign({
    id: "act_" + Date.now() + "_" + Math.random().toString(36).slice(2, 6),
    type: type,
    timestamp: Date.now(),
  }, data || {}));
  if (S.activityLog.length > S.ACTIVITY_MAX) {
    S.activityLog.length = S.ACTIVITY_MAX;
  }
  scheduleActivityPersist();
}

function logToolCall(tool, args, result) {
  var argsPreview;
  try { argsPreview = JSON.stringify(args); }
  catch (_) { argsPreview = "[unserializable]"; }
  if (argsPreview && argsPreview.length > 200) argsPreview = argsPreview.slice(0, 200) + "…";

  S.toolCallLog.unshift({
    id: "tc_" + Date.now() + "_" + Math.random().toString(36).slice(2, 6),
    tool: tool,
    timestamp: Date.now(),
    argsPreview: argsPreview,
    success: !(result && result.error),
  });
  if (S.toolCallLog.length > S.TOOLCALLS_MAX) {
    S.toolCallLog.length = S.TOOLCALLS_MAX;
  }
  scheduleActivityPersist();
}

// Persistence — store the activity + tool-call buffers so reopening Nova
// keeps recent context visible. We don't persist `pendingDiffs`: each diff
// holds a Claude-side requestId from a session that is gone after a
// restart, so reviving it would just produce dangling responses.
function activityStorePath() {
  return nova.path.join(nova.extension.globalStoragePath, "activity.json");
}

function loadActivityLog() {
  try {
    var path = activityStorePath();
    if (!nova.fs.stat(path)) return;
    var f = nova.fs.open(path, "r");
    var raw = f.read() || "";
    f.close();
    if (!raw) return;
    var parsed = JSON.parse(raw);
    if (Array.isArray(parsed.activityLog)) {
      S.activityLog = parsed.activityLog.slice(0, S.ACTIVITY_MAX);
    }
    if (Array.isArray(parsed.toolCallLog)) {
      S.toolCallLog = parsed.toolCallLog.slice(0, S.TOOLCALLS_MAX);
    }
    console.log("Claude Code Bridge: restored activity log (" +
      S.activityLog.length + " events, " + S.toolCallLog.length + " tool calls)");
  } catch (err) {
    console.warn("Claude Code Bridge: could not restore activity log:", err.message);
    // Bad file? Wipe it so we don't keep failing every session.
    try { nova.fs.remove(activityStorePath()); } catch (_) {}
  }
}

function scheduleActivityPersist() {
  if (S.activityPersistTimer) return;
  S.activityPersistTimer = setTimeout(function() {
    S.activityPersistTimer = null;
    flushActivityLog();
  }, S.ACTIVITY_PERSIST_DEBOUNCE_MS);
}

function flushActivityLog() {
  if (S.activityPersistTimer) {
    clearTimeout(S.activityPersistTimer);
    S.activityPersistTimer = null;
  }
  try {
    var dir = nova.extension.globalStoragePath;
    try { nova.fs.mkdir(dir); } catch (_) {}
    var f = nova.fs.open(activityStorePath(), "w");
    f.write(JSON.stringify({
      version: 1,
      savedAt: Date.now(),
      activityLog: S.activityLog,
      toolCallLog: S.toolCallLog,
    }));
    f.close();
  } catch (err) {
    console.warn("Claude Code Bridge: could not persist activity log:", err.message);
  }
}

function relativeTime(ts) {
  var diff = (Date.now() - ts) / 1000;
  if (diff < 5) return "just now";
  if (diff < 60) return Math.floor(diff) + "s ago";
  if (diff < 3600) return Math.floor(diff / 60) + "m ago";
  if (diff < 86400) return Math.floor(diff / 3600) + "h ago";
  return new Date(ts).toLocaleDateString();
}

function formatActivityLabel(e) {
  var basename = e.filePath ? nova.path.basename(e.filePath) : "?";
  switch (e.type) {
    case "file_opened":    return "📄  Opened " + basename;
    case "file_saved":     return "💾  Saved " + basename;
    case "file_added":     return "➕  Added " + basename + " to context";
    case "selection_sent": return "✂️  Sent selection from " + basename + formatLineRange(e);
    case "diff_proposed":  return "⚠️  Diff proposed: " + basename + (e.stats ? " (" + formatStats(e.stats) + ")" : "");
    case "diff_accepted":  return "✓  Accepted diff: " + basename + (e.userEdited ? " (with your edits)" : "");
    case "diff_rejected":  return "✗  Rejected diff: " + basename;
    case "claude_edited":  return "🤖  Claude edited " + basename;
    case "claude_stopped": return "🤖  Claude finished" + (e.snippet ? ": " + e.snippet : "");
    case "claude_failed":  return "🔴  Claude turn failed" + (e.errorType ? " (" + e.errorType + ")" : "");
    default:               return e.type + (basename !== "?" ? " · " + basename : "");
  }
}

// Format "L42" or "L42-L58" suffix, leading space included. Returns "" if
// the event has no line info (older persisted events from before line
// numbers were tracked).
function formatLineRange(e) {
  if (typeof e.startLine !== "number" || typeof e.endLine !== "number") return "";
  // Lines are 0-indexed internally; show 1-indexed to match the way users
  // read code in the editor margin.
  var s = e.startLine + 1;
  var en = e.endLine + 1;
  return s === en ? " (L" + s + ")" : " (L" + s + "-L" + en + ")";
}

function formatActivityTooltip(e) {
  var lines = [];
  lines.push(formatActivityLabel(e));
  if (e.filePath) lines.push(e.filePath);
  lines.push(new Date(e.timestamp).toLocaleString());
  if (e.userEdited) lines.push("User edited the proposed content before accepting.");
  if (typeof e.length === "number") lines.push(e.length + " characters");
  return lines.join("\n");
}

// Tooltip for a Pending Diffs row — file path, timestamp, length, then a
// peek of the first lines so the user can tell diffs apart without opening
// the proposed_* tab.
const DIFF_TOOLTIP_PREVIEW_LINES = 5;

const DIFF_TOOLTIP_PREVIEW_LINE_MAX = 100;

function buildDiffTooltip(d) {
  var lines = [];
  lines.push(d.filePath);
  lines.push("Proposed " + new Date(d.openedAt).toLocaleString());
  if (d.stats) lines.push(formatStats(d.stats));
  lines.push((d.newContent ? d.newContent.length : 0) + " characters proposed");

  var content = d.newContent || "";
  if (content.length > 0) {
    var preview = content.split("\n").slice(0, DIFF_TOOLTIP_PREVIEW_LINES).map(function(line) {
      return line.length > DIFF_TOOLTIP_PREVIEW_LINE_MAX
        ? line.slice(0, DIFF_TOOLTIP_PREVIEW_LINE_MAX) + "…"
        : line;
    });
    lines.push("");
    lines.push("Preview:");
    lines.push.apply(lines, preview);
    var totalLines = (content.match(/\n/g) || []).length + 1;
    if (totalLines > DIFF_TOOLTIP_PREVIEW_LINES) {
      lines.push("… (" + (totalLines - DIFF_TOOLTIP_PREVIEW_LINES) + " more lines)");
    }
  }
  return lines.join("\n");
}

// Lightweight diff stats: count lines that are common between original and
// proposed (set intersection on lines), then derive added = new - common,
// removed = old - common. This isn't an exact diff (no positional sense, two
// identical lines count once) but it gives an order-of-magnitude feel for
// "1-line tweak vs. 80-line rewrite" — which is all we need here.
function computeDiffStats(filePath, newContent) {
  var oldContent = "";
  var isNewFile = false;
  try {
    if (nova.fs.stat(filePath)) {
      var f = nova.fs.open(filePath, "r");
      oldContent = f.read() || "";
      f.close();
    } else {
      isNewFile = true;
    }
  } catch (_) {
    isNewFile = true;
  }

  var oldLines = oldContent.length === 0 ? [] : oldContent.split("\n");
  var newLines = (newContent || "").length === 0 ? [] : (newContent || "").split("\n");

  if (isNewFile) {
    return { added: newLines.length, removed: 0, oldLineCount: 0, newLineCount: newLines.length, isNewFile: true };
  }

  // Multiset intersection so duplicate lines are counted properly.
  var oldCounts = Object.create(null);
  for (var i = 0; i < oldLines.length; i++) {
    oldCounts[oldLines[i]] = (oldCounts[oldLines[i]] || 0) + 1;
  }
  var common = 0;
  for (var j = 0; j < newLines.length; j++) {
    if (oldCounts[newLines[j]] > 0) {
      common++;
      oldCounts[newLines[j]]--;
    }
  }

  return {
    added: newLines.length - common,
    removed: oldLines.length - common,
    oldLineCount: oldLines.length,
    newLineCount: newLines.length,
    isNewFile: false,
  };
}

function formatStats(stats) {
  if (!stats) return "";
  if (stats.isNewFile) return "new file, +" + stats.added + " lines";
  return "+" + stats.added + " / -" + stats.removed + " lines";
}

R.Activity = Object.assign(R.Activity || {}, {
  logActivity,
  logToolCall,
  activityStorePath,
  loadActivityLog,
  scheduleActivityPersist,
  flushActivityLog,
  relativeTime,
  formatActivityLabel,
  formatLineRange,
  formatActivityTooltip,
  DIFF_TOOLTIP_PREVIEW_LINES,
  DIFF_TOOLTIP_PREVIEW_LINE_MAX,
  buildDiffTooltip,
  computeDiffStats,
  formatStats,
});
module.exports = R.Activity;
