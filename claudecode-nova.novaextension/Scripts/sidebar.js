// sidebar.js — Sidebar tree providers, sidebar click-through commands, diff Accept/Reject, sessions watcher + resume flows, git branch tracking.
//
// Split out of the former 3 500-line main.js (v0.28.0). Runs in Nova's
// JavaScriptCore runtime (CommonJS require, no Node built-ins). Nova's
// require() does NOT support circular dependencies (it recurses until
// "Maximum call stack size exceeded"), so modules never require each other:
// each one attaches its exports to the shared registry (R.<Name>) at the
// bottom, and cross-module calls dereference R.<Name>.fn at call time.

const S = require("./state.js");
const R = require("./registry.js");
const { ChatStatusTreeProvider } = require("./chat-status-tree-provider.js");
const { SessionsTreeProvider, sessionDirForWorkspace } = require("./sessions-tree-provider.js");
const { VersionTreeProvider } = require("./version-tree-provider.js");

class StatusDataProvider {
  getChildren(element) {
    if (!element) {
      return [
        { id: "status", label: S.serverProcess ? "● Server Running" : "○ Server Stopped" },
        { id: "port", label: "Port: " + (S.serverPort || "—") },
        { id: "clients", label: "Clients: " + S.clientCount },
      ];
    }
    return [];
  }

  getTreeItem(element) {
    var item = new TreeItem(element.label);
    item.identifier = element.id;
    return item;
  }
}

// Pending Diffs section. Each diff is a parent node with two child items
// "Accept" and "Reject" — Nova does not expose per-row inline buttons, so
// double-click on the children is the user-facing affordance.
class PendingDiffsDataProvider {
  getChildren(element) {
    if (!element) {
      return S.pendingDiffs.map(function(d) { return { kind: "diff", data: d }; });
    }
    if (element.kind === "diff") {
      return [
        { kind: "diffAction", action: "accept", diffId: element.data.id },
        { kind: "diffAction", action: "reject", diffId: element.data.id },
      ];
    }
    return [];
  }

  getTreeItem(element) {
    if (element.kind === "diff") {
      var d = element.data;
      var item = new TreeItem(nova.path.basename(d.filePath));
      item.identifier = d.id;
      // Show diff size inline so the user can triage at-a-glance — a
      // 1-line tweak looks very different from an 80-line rewrite. Falls
      // back to just time when stats aren't computed yet.
      item.descriptiveText = d.stats
        ? R.Activity.formatStats(d.stats) + "  ·  " + R.Activity.relativeTime(d.openedAt)
        : R.Activity.relativeTime(d.openedAt);
      item.tooltip = R.Activity.buildDiffTooltip(d);
      item.collapsibleState = TreeItemCollapsibleState.Expanded;
      item.command = "claudecode.diffShowDetails";
      return item;
    }
    if (element.kind === "diffAction") {
      var label = element.action === "accept" ? "✓  Accept" : "✗  Reject";
      var item = new TreeItem(label);
      item.identifier = element.diffId + "_" + element.action;
      item.command = element.action === "accept" ? "claudecode.diffAccept" : "claudecode.diffReject";
      return item;
    }
    return null;
  }
}

// Activity section: visible-effect events first, then a collapsible group
// "Tool Calls (N)" with the raw tool-call log underneath.
class ActivityDataProvider {
  getChildren(element) {
    if (!element) {
      var items = S.activityLog.map(function(e) { return { kind: "activity", data: e }; });
      items.push({ kind: "group", id: "toolcalls", label: "Tool Calls (" + S.toolCallLog.length + ")" });
      return items;
    }
    if (element.kind === "group" && element.id === "toolcalls") {
      return S.toolCallLog.map(function(t) { return { kind: "toolcall", data: t }; });
    }
    return [];
  }

  getTreeItem(element) {
    if (element.kind === "group") {
      var item = new TreeItem(element.label);
      item.identifier = element.id;
      item.collapsibleState = TreeItemCollapsibleState.Collapsed;
      return item;
    }
    if (element.kind === "activity") {
      var e = element.data;
      var item = new TreeItem(R.Activity.formatActivityLabel(e));
      item.identifier = e.id;
      item.descriptiveText = R.Activity.relativeTime(e.timestamp);
      item.tooltip = R.Activity.formatActivityTooltip(e);
      item.command = "claudecode.activityClick";
      return item;
    }
    if (element.kind === "toolcall") {
      var t = element.data;
      var item = new TreeItem(t.tool + (t.success ? "" : "  ✗"));
      item.identifier = t.id;
      item.descriptiveText = R.Activity.relativeTime(t.timestamp);
      item.tooltip = t.tool + " · " + new Date(t.timestamp).toLocaleString() + "\n" + t.argsPreview;
      return item;
    }
    return null;
  }
}

function updateSidebar() {
  try {
    if (!S.sidebarProvider) {
      S.sidebarProvider = new StatusDataProvider();
      S.sidebarTree = new TreeView("claudecode.sidebar.status", {
        dataProvider: S.sidebarProvider,
      });
      S.disposables.push(S.sidebarTree);
    }
    S.sidebarTree.reload();
  } catch (err) {
    console.error("Claude Code Bridge: sidebar update failed:", err.message);
  }
}

function ensureActivitySidebars() {
  try {
    if (!S.diffsProvider) {
      S.diffsProvider = new PendingDiffsDataProvider();
      S.diffsTree = new TreeView("claudecode.sidebar.diffs", {
        dataProvider: S.diffsProvider,
      });
      S.disposables.push(S.diffsTree);
    }
    if (!S.activityProvider) {
      S.activityProvider = new ActivityDataProvider();
      S.activityTree = new TreeView("claudecode.sidebar.activity", {
        dataProvider: S.activityProvider,
      });
      S.disposables.push(S.activityTree);
    }
    if (!S.versionProvider) {
      S.versionProvider = new VersionTreeProvider(S.versionState);
      S.versionTree = new TreeView("claudecode.sidebar.version", {
        dataProvider: S.versionProvider,
      });
      S.disposables.push(S.versionTree);
    }
    if (!S.sessionsProvider) {
      S.sessionsProvider = new SessionsTreeProvider();
      try { S.sessionsProvider.refresh(); }
      catch (e) { console.warn("Claude Code Bridge: initial sessions scan failed:", e.message); }
      S.sessionsTree = new TreeView("claudecode.sidebar.sessions", {
        dataProvider: S.sessionsProvider,
      });
      S.disposables.push(S.sessionsTree);
      startSessionsWatcher();
    }
    if (!S.chatStatusProvider) {
      // Hydrate from config so the row reflects intent immediately, even
      // before startBridge() has a chance to mutate the state.
      if (nova.config.get("claudecode.chat.enabled") !== true) {
        S.chatState.state = "disabled";
      }
      S.chatStatusProvider = new ChatStatusTreeProvider(S.chatState);
      S.chatStatusTree = new TreeView("claudecode.sidebar.chat", {
        dataProvider: S.chatStatusProvider,
      });
      S.disposables.push(S.chatStatusTree);
    }
  } catch (err) {
    console.error("Claude Code Bridge: activity sidebar init failed:", err.message);
  }
}

function refreshChatStatusSidebar() {
  ensureActivitySidebars();
  S.chatState.lastUpdatedAt = Date.now();
  try { if (S.chatStatusTree) S.chatStatusTree.reload(); } catch (_) {}
}

function startSessionsWatcher() {
  if (S.sessionsWatcher) return;
  var dir = sessionDirForWorkspace();
  if (!dir) return;
  try {
    S.sessionsWatcher = nova.fs.watch(dir + "/*.jsonl", function() {
      if (S.sessionsRefreshTimer) return;
      S.sessionsRefreshTimer = setTimeout(function() {
        S.sessionsRefreshTimer = null;
        refreshSessionsSidebar();
      }, 500);
    });
    S.disposables.push(S.sessionsWatcher);
  } catch (err) {
    console.warn("Claude Code Bridge: sessions watcher failed:", err.message);
  }
}

function refreshSessionsSidebar() {
  if (!S.sessionsProvider || !S.sessionsTree) return;
  try {
    S.sessionsProvider.refresh();
    S.sessionsTree.reload();
  } catch (err) {
    console.error("Claude Code Bridge: sessions refresh failed:", err.message);
  }
}

function refreshVersionSidebar() {
  ensureActivitySidebars();
  try { if (S.versionTree) S.versionTree.reload(); } catch (_) {}
}

// Reload both activity-related sections. Called after every event that
// changes activityLog / toolCallLog / pendingDiffs, plus on a 30s timer
// so relative timestamps ("2m ago") stay accurate.
function refreshActivitySidebar() {
  ensureActivitySidebars();
  try {
    if (S.diffsTree) S.diffsTree.reload();
    if (S.activityTree) S.activityTree.reload();
  } catch (_) {}
}

function startActivityRefreshTimer() {
  if (S.activityRefreshTimer) return;
  S.activityRefreshTimer = setInterval(activityTick, 30000);
}

function stopActivityRefreshTimer() {
  if (S.activityRefreshTimer) {
    clearInterval(S.activityRefreshTimer);
    S.activityRefreshTimer = null;
  }
}

// Combined tick: keep relative timestamps fresh AND auto-reject diffs that
// have been pending too long. Driven by a single 30s interval so we don't
// stack timers.
function activityTick() {
  sweepStaleDiffs();
  refreshActivitySidebar();
}

// Auto-reject diffs older than `claudecode.diffTimeoutMinutes`. Catches the
// case where Claude crashes or disconnects mid-flow — without this the
// requestId stays in pendingDiffs forever and the sidebar fills up. Set the
// setting to 0 to disable.
function sweepStaleDiffs() {
  var minutes = nova.config.get("claudecode.diffTimeoutMinutes");
  if (typeof minutes !== "number") minutes = 30;
  if (minutes <= 0) return;
  var cutoff = Date.now() - minutes * 60 * 1000;
  var stale = S.pendingDiffs.filter(function(d) { return d.openedAt < cutoff; });
  for (var i = 0; i < stale.length; i++) {
    console.log("Claude Code Bridge: auto-rejecting stale diff for " + stale[i].filePath);
    try { R.Tools.resolveDiff(stale[i].id, false); } catch (_) {}
  }
}

//
// `git rev-parse --abbrev-ref HEAD` gives us the current branch (or "HEAD"
// if detached). We cache the result and refresh on bridge start, after the
// 5-minute interval, and on demand. The cached value is included in
// selection_update payloads (cheap, just a string) and in
// getWorkspaceFolders.

function startGitBranchRefresh() {
  refreshGitBranch();
  if (S.gitBranchTimer) return;
  S.gitBranchTimer = setInterval(refreshGitBranch, S.GIT_BRANCH_REFRESH_MS);
}

function stopGitBranchRefresh() {
  if (S.gitBranchTimer) {
    clearInterval(S.gitBranchTimer);
    S.gitBranchTimer = null;
  }
}

function refreshGitBranch() {
  var workspace = nova.workspace.path;
  if (!workspace) {
    S.gitBranch = null;
    return;
  }
  var proc;
  try {
    proc = new Process("/usr/bin/env", {
      args: ["git", "rev-parse", "--abbrev-ref", "HEAD"],
      cwd: workspace,
      shell: false,
    });
  } catch (err) {
    console.warn("Claude Code Bridge: cannot spawn git:", err.message);
    return;
  }
  var stdout = "";
  proc.onStdout(function(d) { stdout += d; });
  proc.onDidExit(function(code) {
    if (code === 0) {
      var branch = stdout.trim();
      if (branch && branch !== S.gitBranch) {
        console.log("Claude Code Bridge: git branch = " + branch);
      }
      S.gitBranch = branch || null;
    } else {
      // Not a git repo, or git not installed. Stay quiet.
      S.gitBranch = null;
    }
  });
  try { proc.start(); } catch (_) { S.gitBranch = null; }
}

function activityClickHandler() {
  if (!S.activityTree) return;
  var sel = S.activityTree.selection;
  if (!sel || sel.length === 0) return;
  var element = sel[0];
  if (!element || element.kind !== "activity") return;

  var e = element.data;
  if (e.filePath && (e.type === "file_opened" || e.type === "file_saved" ||
                     e.type === "file_added" || e.type === "selection_sent")) {
    nova.workspace.openFile(e.filePath).catch(function(err) {
      console.error("Claude Code Bridge: openFile failed:", err.message);
    });
    return;
  }
  // Diff events → details dialog
  showActivityDetailsDialog(e);
}

function showActivityDetailsDialog(e) {
  var req = new NotificationRequest("claudecode-act-" + e.id);
  req.title = R.Activity.formatActivityLabel(e);
  req.body = R.Activity.formatActivityTooltip(e);
  req.actions = e.filePath ? ["Open File", "OK"] : ["OK"];
  nova.notifications.add(req).then(function(response) {
    if (e.filePath && response.actionIdx === 0) {
      nova.workspace.openFile(e.filePath).catch(function(_) {});
    }
  });
}

function diffAcceptHandler() {
  var diffId = currentSelectedDiffId();
  if (diffId) R.Tools.resolveDiff(diffId, true);
}

function diffRejectHandler() {
  var diffId = currentSelectedDiffId();
  if (diffId) R.Tools.resolveDiff(diffId, false);
}

function diffShowDetailsHandler() {
  var diffId = currentSelectedDiffId();
  if (!diffId) return;
  var diff = S.pendingDiffs.find(function(d) { return d.id === diffId; });
  if (!diff) return;
  var req = new NotificationRequest("claudecode-diff-details-" + diffId);
  req.title = "Diff: " + nova.path.basename(diff.filePath);
  var bodyLines = [
    diff.filePath,
    "Proposed: " + new Date(diff.openedAt).toLocaleString(),
  ];
  if (diff.stats) bodyLines.push("Change: " + R.Activity.formatStats(diff.stats));
  bodyLines.push("Proposal length: " + diff.newContent.length + " characters");
  bodyLines.push("Tab name: " + diff.tabName);
  req.body = bodyLines.join("\n");
  req.actions = ["Open Proposed Tab", "Accept", "Reject", "Cancel"];
  nova.notifications.add(req).then(function(response) {
    if (response.actionIdx === 0) {
      nova.workspace.openFile(diff.tmpFile).catch(function(_) {});
    } else if (response.actionIdx === 1) {
      R.Tools.resolveDiff(diffId, true);
    } else if (response.actionIdx === 2) {
      R.Tools.resolveDiff(diffId, false);
    }
  });
}

// Extract the diffId from whichever item in the diffs tree is currently
// selected (the parent node OR one of its Accept/Reject children).
function currentSelectedDiffId() {
  if (!S.diffsTree) return null;
  var sel = S.diffsTree.selection;
  if (!sel || sel.length === 0) return null;
  var element = sel[0];
  if (!element) return null;
  if (element.kind === "diff") return element.data.id;
  if (element.kind === "diffAction") return element.diffId;
  return null;
}

function activityClearHandler() {
  S.activityLog = [];
  S.toolCallLog = [];
  refreshActivitySidebar();
  R.Util.showNotification("Cleared", "Activity log cleared.");
}

function sidebarRefreshHandler() {
  updateSidebar();
  refreshActivitySidebar();
  refreshSessionsSidebar();
}

function sessionsRefreshHandler() {
  refreshSessionsSidebar();
}

// Triggered by double-click on a Recent Sessions tree item. Reads the
// selected sessionId from the tree's selection, builds the resume command
// honouring the workspace's `claudecode.claudeCommand` setting, and copies
// it to the clipboard. We don't launch a terminal here — Nova has no
// programmatic terminal API, so the user pastes into whatever shell they're
// already using (Project Terminal, iTerm, etc.).
// Clicking a Recent Sessions row pops an action panel asking WHERE to
// resume — the chat web UI, the embedded CLI panel, an external
// terminal, or just copy the command. Picking "Chat web" or "CLI
// panel" also opens / refreshes the chat window so the user lands
// straight on the right surface.
function resumeSessionHandler() {
  if (!S.sessionsTree) return;
  var sel = S.sessionsTree.selection;
  if (!sel || sel.length === 0) return;
  var element = sel[0];
  if (!element || !element.sessionId) return;

  var sessionId = element.sessionId;
  var claudeCmd = nova.workspace.config.get("claudecode.claudeCommand") || "claude";
  var resumeCmd = claudeCmd + " --resume " + sessionId;

  nova.workspace.showActionPanel(
    "Resume session " + sessionId.slice(0, 8) + "…\n\n" + (element.preview || ""),
    { buttons: ["Chat (web)", "CLI panel", "Terminal", "Copy command", "Cancel"] },
    function(idx) {
      if (idx === 0)      resumeSessionInChat(sessionId);
      else if (idx === 1) resumeSessionInCliPanel(sessionId);
      else if (idx === 2) resumeSessionInTerminal(sessionId);
      else if (idx === 3) {
        try {
          nova.clipboard.writeText(resumeCmd);
          R.Util.showNotification("Copied", resumeCmd);
        } catch (err) {
          R.Util.showNotification("Copy failed", err.message);
        }
      }
    }
  );
}

// Resume in the web chat UI. Sends a resume_external broadcast to
// every open chat client; whichever surface the user is using
// (browser tab, Nova Preview, etc.) picks it up. We deliberately
// don't try to open the wrapper file here — Nova's API can't tell
// whether the Preview tab is already up, and openFile() would force
// the source-HTML tab to the front and bury the user's actual
// Preview view. If no chat is open, the user opens one manually via
// the "Open Claude Chat in Browser" command.
function resumeSessionInChat(sessionId) {
  if (!nova.config.get("claudecode.chat.enabled")) {
    R.Util.showNotification("Chat disabled", "Enable Chat UI in extension settings to resume there.");
    return;
  }
  R.Bridge.sendToServer({ type: "resume_in_chat", sessionId: sessionId });
  R.Util.showNotification(
    "Resume sent to chat",
    "If the chat window isn't open, run \"Open Claude Chat in Browser\" first, then click Resume again."
  );
}

// Resume inside the embedded xterm.js terminal panel. ws-server
// reconnects the /cli WS spawning `claude --resume <id>` this time.
// Same rationale as resumeSessionInChat: we don't reopen the wrapper.
function resumeSessionInCliPanel(sessionId) {
  if (!nova.config.get("claudecode.chat.enabled")) {
    R.Util.showNotification("Chat disabled", "Enable Chat UI in extension settings to resume in the embedded CLI panel.");
    return;
  }
  R.Bridge.sendToServer({ type: "resume_in_cli", sessionId: sessionId });
  R.Util.showNotification(
    "Resume sent to CLI panel",
    "If the chat window isn't open, run \"Open Claude Chat in Browser\" first, then click Resume again."
  );
}

// Resume in an external terminal (iTerm / Terminal.app / etc.).
// Reuses the existing launchClaude pipeline by temporarily injecting
// the --resume arg into claudecode.claudeArgs for this one call.
async function resumeSessionInTerminal(sessionId) {
  // Build the command line that launchClaude builds, but with the
  // extra --resume flag prepended. We can't mutate the setting just
  // for this call, so reimplement the minimal launch here.
  var claudeCmd = nova.workspace.config.get("claudecode.claudeCommand") || "claude";
  var extraArgs = (nova.workspace.config.get("claudecode.claudeArgs") || "").trim();
  var command = claudeCmd + " --resume " + sessionId + (extraArgs ? " " + extraArgs : "");
  var terminalApp = nova.config.get("claudecode.terminalApp") || "auto";

  // Inline launch via the same osascript-based flow launchClaude uses
  // for iTerm / Terminal. For "clipboard" or unknown terminals, just
  // copy and notify.
  if (terminalApp === "clipboard") {
    nova.clipboard.writeText(command);
    R.Util.showNotification("Copied", command);
    return;
  }

  // Delegate to launchClaude by temporarily setting an env var the
  // helper can read. Simpler: just exec osascript here for the two
  // supported terminals. iTerm first, then fall back to Terminal.
  var script;
  if (terminalApp === "Terminal") {
    script = 'tell application "Terminal" to do script "' + command.replace(/"/g, '\\"') + '"\n' +
             'tell application "Terminal" to activate';
  } else {
    // iTerm or auto — try iTerm
    script =
      'tell application "iTerm" to activate\n' +
      'tell application "iTerm"\n' +
      '  if (count of windows) = 0 then create window with default profile\n' +
      '  tell current window to create tab with default profile\n' +
      '  tell current session of current window to write text "' + command.replace(/"/g, '\\"') + '"\n' +
      'end tell';
  }
  try {
    var proc = new Process("/usr/bin/osascript", { args: ["-e", script], stdio: "ignore" });
    proc.start();
    R.Util.showNotification("Resumed in Terminal", "Session " + sessionId.slice(0, 8) + "… opened.");
  } catch (err) {
    nova.clipboard.writeText(command);
    R.Util.showNotification("Copied (osascript failed)", command);
  }
}

R.Sidebar = Object.assign(R.Sidebar || {}, {
  StatusDataProvider,
  PendingDiffsDataProvider,
  ActivityDataProvider,
  updateSidebar,
  ensureActivitySidebars,
  refreshChatStatusSidebar,
  startSessionsWatcher,
  refreshSessionsSidebar,
  refreshVersionSidebar,
  refreshActivitySidebar,
  startActivityRefreshTimer,
  stopActivityRefreshTimer,
  activityTick,
  sweepStaleDiffs,
  startGitBranchRefresh,
  stopGitBranchRefresh,
  refreshGitBranch,
  activityClickHandler,
  showActivityDetailsDialog,
  diffAcceptHandler,
  diffRejectHandler,
  diffShowDetailsHandler,
  currentSelectedDiffId,
  activityClearHandler,
  sidebarRefreshHandler,
  sessionsRefreshHandler,
  resumeSessionHandler,
  resumeSessionInChat,
  resumeSessionInCliPanel,
  resumeSessionInTerminal,
});
module.exports = R.Sidebar;
