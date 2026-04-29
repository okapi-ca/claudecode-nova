/**
 * Claude Code Bridge for Nova
 *
 * Main extension entry point. This file:
 *   1. Spawns the Node.js WebSocket server helper (ws-server.js)
 *   2. Communicates with it via JSON lines over stdin/stdout
 *   3. Maps MCP tool calls to Nova editor APIs
 *   4. Tracks editor selection and broadcasts changes
 *   5. Provides sidebar UI and commands
 */

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let serverProcess = null;
let serverPort = null;
let isConnected = false;
let clientCount = 0;
let disposables = [];
let lastSelection = null;
let stdoutBuffer = "";

// Activity tracking — feeds the Activity and Pending Diffs sidebar sections.
// activityLog: visible-effect events (file_opened, diff_accepted, …).
// toolCallLog: every raw tool call, surfaced under a collapsible group.
// pendingDiffs: diffs awaiting Accept/Reject (notification + sidebar both
//   resolve through resolveDiff()).
let activityLog = [];
let toolCallLog = [];
let pendingDiffs = [];
const ACTIVITY_MAX = 50;
const TOOLCALLS_MAX = 100;
let activityRefreshTimer = null;

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

exports.activate = function() {
  console.log("Claude Code Bridge: activate() called");

  try {
    disposables.push(
      nova.commands.register("claudecode.start", startBridge),
      nova.commands.register("claudecode.stop", stopBridge),
      nova.commands.register("claudecode.sendSelection", sendSelectionToContext),
      nova.commands.register("claudecode.addFile", addCurrentFile),
      nova.commands.register("claudecode.status", showStatus),
      nova.commands.register("claudecode.launchClaude", launchClaude),
      nova.commands.register("claudecode.activityClick", activityClickHandler),
      nova.commands.register("claudecode.activityClear", activityClearHandler),
      nova.commands.register("claudecode.diffAccept", diffAcceptHandler),
      nova.commands.register("claudecode.diffReject", diffRejectHandler),
      nova.commands.register("claudecode.diffShowDetails", diffShowDetailsHandler),
      nova.commands.register("claudecode.sidebarRefresh", sidebarRefreshHandler),
    );
    console.log("Claude Code Bridge: commands registered");
  } catch (err) {
    console.error("Claude Code Bridge: failed to register commands:", err.message);
    return;
  }

  // Pre-build the activity sidebars so they render immediately
  // (placeholder text) instead of staying blank until the first event.
  ensureActivitySidebars();
  startActivityRefreshTimer();

  const autoStart = nova.config.get("claudecode.autoStart");
  if (autoStart !== false) {
    try {
      startBridge();
    } catch (err) {
      console.error("Claude Code Bridge: startBridge() failed:", err.message, err.stack || "");
      showNotification("Error", `Failed to start bridge: ${err.message}`);
    }
  }

  console.log("Claude Code Bridge: activation complete");
};

exports.deactivate = function() {
  console.log("Claude Code Bridge: deactivating…");
  stopActivityRefreshTimer();
  stopBridge();
  for (const d of disposables) {
    try { d.dispose(); } catch (_) {}
  }
  disposables = [];
};

// ---------------------------------------------------------------------------
// Resolve Node.js path
// ---------------------------------------------------------------------------

function resolveNodePath() {
  const configured = nova.config.get("claudecode.nodePath");
  if (configured && configured !== "node") {
    return configured;
  }

  // Common Node.js locations (nvm, homebrew, system)
  const candidates = [
    nova.environment["HOME"] + "/.nvm/versions/node/v22.22.0/bin/node",
    "/usr/local/bin/node",
    "/opt/homebrew/bin/node",
    "/usr/bin/node",
  ];

  for (const candidate of candidates) {
    try {
      if (nova.fs.stat(candidate)) {
        console.log("Claude Code Bridge: found node at " + candidate);
        return candidate;
      }
    } catch (_) {}
  }

  // Fallback: try bare "node" and hope it's in PATH
  console.warn("Claude Code Bridge: no node binary found at known paths, trying 'node'");
  return "node";
}

// ---------------------------------------------------------------------------
// Bridge lifecycle
// ---------------------------------------------------------------------------

function startBridge() {
  if (serverProcess) {
    console.log("Claude Code Bridge: already running");
    showNotification("Already Running", "Claude Code Bridge is already active.");
    return;
  }

  const nodePath = resolveNodePath();
  const portMin  = nova.config.get("claudecode.portMin") || 10000;
  const portMax  = nova.config.get("claudecode.portMax") || 65535;
  const workspace = nova.workspace.path || "";

  const scriptPath = nova.path.join(nova.extension.path, "Scripts", "ws-server.js");

  console.log("Claude Code Bridge: starting server");
  console.log("  Node: " + nodePath);
  console.log("  Script: " + scriptPath);
  console.log("  Workspace: " + workspace);

  try {
    serverProcess = new Process(nodePath, {
      args: [scriptPath],
      env: {
        CC_PORT_MIN: String(portMin),
        CC_PORT_MAX: String(portMax),
        CC_WORKSPACE: workspace,
      },
      cwd: workspace || undefined,
      stdio: "pipe",
    });
  } catch (err) {
    console.error("Claude Code Bridge: failed to create Process:", err.message);
    showNotification("Error", "Cannot create server process: " + err.message);
    return;
  }

  // Reset stdout line buffer
  stdoutBuffer = "";

  // Read JSON lines from server stdout (may arrive as partial chunks)
  serverProcess.onStdout(function(chunk) {
    stdoutBuffer += chunk;
    var newlineIdx;
    while ((newlineIdx = stdoutBuffer.indexOf("\n")) !== -1) {
      var line = stdoutBuffer.slice(0, newlineIdx).trim();
      stdoutBuffer = stdoutBuffer.slice(newlineIdx + 1);
      if (line.length === 0) continue;
      try {
        handleServerMessage(JSON.parse(line));
      } catch (err) {
        console.error("Claude Code Bridge: failed to parse server message:", line, err.message);
      }
    }
  });

  serverProcess.onStderr(function(data) {
    console.warn("Claude Code Bridge [server stderr]: " + data.trim());
  });

  serverProcess.onDidExit(function(exitCode) {
    console.log("Claude Code Bridge: server exited with code " + exitCode);
    serverProcess = null;
    serverPort = null;
    isConnected = false;
    clientCount = 0;
    stdoutBuffer = "";
    updateSidebar();
    if (exitCode !== 0) {
      showNotification("Server Stopped", "WebSocket server exited with code " + exitCode + ". Check Extension Console for details.");
    }
  });

  try {
    serverProcess.start();
    console.log("Claude Code Bridge: process started successfully");
  } catch (err) {
    console.error("Claude Code Bridge: process.start() failed:", err.message);
    showNotification("Error", "Cannot start node process: " + err.message + "\nConfigure the Node.js path in extension settings.");
    serverProcess = null;
    return;
  }

  // Start tracking editor selection
  var trackSelection = nova.config.get("claudecode.trackSelection");
  if (trackSelection !== false) {
    startSelectionTracking();
  }

  showNotification("Starting", "Claude Code Bridge is starting…");
}

function stopBridge() {
  if (serverProcess) {
    console.log("Claude Code Bridge: stopping server…");
    try { serverProcess.terminate(); } catch (_) {}
    serverProcess = null;
    serverPort = null;
    isConnected = false;
    clientCount = 0;
    stdoutBuffer = "";
    updateSidebar();
    showNotification("Stopped", "Claude Code Bridge has been stopped.");
  }
}

// ---------------------------------------------------------------------------
// Communication with WebSocket server subprocess
// ---------------------------------------------------------------------------

function sendToServer(obj) {
  if (!serverProcess) return;
  try {
    var writer = serverProcess.stdin.getWriter();
    writer.write(JSON.stringify(obj) + "\n");
    writer.releaseLock();
  } catch (err) {
    console.error("Claude Code Bridge: failed to send to server:", err.message);
  }
}

function handleServerMessage(msg) {
  switch (msg.type) {
    case "server_started":
      serverPort = msg.port;
      console.log("Claude Code Bridge: server started on port " + msg.port);
      showNotification(
        "Ready",
        "WebSocket MCP server on port " + msg.port + ".\nUse \"Launch Claude\" command, or run:\nCLAUDE_CODE_SSE_PORT=" + msg.port + " ENABLE_IDE_INTEGRATION=true claude"
      );
      updateSidebar();
      break;

    case "client_connected":
      isConnected = true;
      clientCount = msg.clientCount || 1;
      console.log("Claude Code Bridge: Claude Code client connected");
      showNotification("Connected", "Claude Code is now connected to Nova!");
      updateSidebar();
      break;

    case "client_disconnected":
      clientCount = msg.clientCount || 0;
      isConnected = clientCount > 0;
      updateSidebar();
      break;

    case "tool_call":
      handleToolCall(msg);
      break;

    case "log":
      if (msg.level === "error") {
        console.error("[ws-server] " + msg.message);
      } else {
        console.log("[ws-server] " + msg.message);
      }
      break;
  }
}

// ---------------------------------------------------------------------------
// MCP Tool handlers — mapping Claude Code tools to Nova APIs
// ---------------------------------------------------------------------------

async function handleToolCall(msg) {
  var requestId = msg.requestId;
  var tool = msg.tool;
  var args = msg.arguments || {};
  var result;

  try {
    switch (tool) {
      case "openFile":
        result = await toolOpenFile(args);
        break;
      case "openDiff":
        // openDiff is special: it logs its own activity event (diff_proposed)
        // inside toolOpenDiff to capture the diffId, and resolves through
        // resolveDiff() rather than the synchronous tool_result path.
        logToolCall(tool, args, { deferred: true });
        await toolOpenDiff(args, requestId);
        return;
      case "getCurrentSelection":
        result = toolGetCurrentSelection();
        break;
      case "getLatestSelection":
        result = toolGetLatestSelection();
        break;
      case "getOpenEditors":
        result = toolGetOpenEditors();
        break;
      case "getWorkspaceFolders":
        result = toolGetWorkspaceFolders();
        break;
      case "checkDocumentDirty":
        result = toolCheckDocumentDirty(args);
        break;
      case "saveDocument":
        result = await toolSaveDocument(args);
        break;
      case "getDiagnostics":
        result = toolGetDiagnostics(args);
        break;
      case "closeAllDiffTabs":
        result = toolCloseAllDiffTabs();
        break;
      default:
        result = { error: "Unknown tool: " + tool };
    }
  } catch (err) {
    console.error("Claude Code Bridge: tool error [" + tool + "]:", err.message);
    result = { error: err.message };
  }

  // Log the raw tool call (collapsible group in the Activity sidebar) plus
  // the user-visible action when this call had an externally-visible effect.
  logToolCall(tool, args, result);
  if (!result || !result.error) {
    if (tool === "openFile" && args.filePath) {
      logActivity("file_opened", { filePath: args.filePath });
    } else if (tool === "saveDocument" && args.filePath) {
      logActivity("file_saved", { filePath: args.filePath });
    }
  }
  refreshActivitySidebar();

  sendToServer({ type: "tool_result", requestId: requestId, result: result });
}

// --- openFile ---
async function toolOpenFile(args) {
  var filePath = args.filePath;
  if (!filePath) return { error: "filePath is required" };

  try {
    await nova.workspace.openFile(filePath);

    if (args.lineNumber) {
      await delay(100);
      var editor = nova.workspace.activeTextEditor;
      if (editor && editor.document.path === filePath) {
        var line = Math.max(0, args.lineNumber - 1);
        var lineRange = editor.document.getLineRangeForRange(new Range(line, line));
        editor.selectedRange = new Range(lineRange.start, lineRange.start);
        editor.scrollToCursorPosition();
      }
    }

    return { success: true, filePath: filePath };
  } catch (err) {
    return { error: err.message };
  }
}

// --- openDiff ---
//
// Stages the proposed change as a temp file alongside the original, registers
// it in pendingDiffs so the sidebar can show it, and posts an Accept/Reject
// notification. Either path (notification button OR sidebar command) ends up
// calling resolveDiff(diffId, accepted).
async function toolOpenDiff(args, requestId) {
  var filePath = args.filePath;
  var newContent = args.newContent;
  var tabName = args.tabName;

  try {
    var tmpDir = nova.path.join(nova.extension.globalStoragePath, "diffs");
    try { nova.fs.mkdir(tmpDir); } catch (_) {}
    var tmpFile = nova.path.join(tmpDir, "proposed_" + Date.now() + "_" + nova.path.basename(filePath));

    var file = nova.fs.open(tmpFile, "w");
    file.write(newContent);
    file.close();

    await nova.workspace.openFile(filePath);
    await nova.workspace.openFile(tmpFile);

    var diffId = "diff_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);
    pendingDiffs.unshift({
      id: diffId,
      filePath: filePath,
      tmpFile: tmpFile,
      newContent: newContent,
      tabName: tabName || "proposed",
      requestId: requestId,
      openedAt: Date.now(),
    });
    logActivity("diff_proposed", { filePath: filePath, diffId: diffId });
    refreshActivitySidebar();

    var notification = new NotificationRequest("claudecode-diff-" + diffId);
    notification.title = "Claude Code Diff";
    notification.body = "Review changes for " + nova.path.basename(filePath) + ".\nProposed changes are open in a new tab (" + (tabName || "proposed") + ").";
    notification.actions = ["Accept Changes", "Reject"];

    nova.notifications.add(notification).then(function(response) {
      resolveDiff(diffId, response.actionIdx === 0);
    });

  } catch (err) {
    sendToServer({
      type: "tool_result",
      requestId: requestId,
      result: { error: err.message },
    });
  }
}

// Apply or reject a pending diff. Idempotent: if the diff has already been
// resolved (e.g., user clicked the notification then the sidebar button),
// the second call is a no-op. This is what lets sidebar commands and the
// notification handler share the same code path.
function resolveDiff(diffId, accepted) {
  var idx = pendingDiffs.findIndex(function(d) { return d.id === diffId; });
  if (idx === -1) return;
  var diff = pendingDiffs[idx];
  pendingDiffs.splice(idx, 1);

  // Cancel any lingering notification — clicking Accept/Reject in the sidebar
  // should make the system notification disappear immediately rather than
  // dangle until the user dismisses it.
  try { nova.notifications.cancel("claudecode-diff-" + diffId); } catch (_) {}

  var userEdited = false;
  var finalContent = diff.newContent;

  if (accepted) {
    try {
      var inFile = nova.fs.open(diff.tmpFile, "r");
      finalContent = inFile.read() || "";
      inFile.close();
      userEdited = (finalContent !== diff.newContent);

      var outFile = nova.fs.open(diff.filePath, "w");
      outFile.write(finalContent);
      outFile.close();
      console.log("Claude Code Bridge: accepted diff for " + diff.filePath + (userEdited ? " (with user edits)" : ""));
    } catch (err) {
      console.error("Claude Code Bridge: failed to apply diff:", err.message);
    }
  }

  try { nova.fs.remove(diff.tmpFile); } catch (_) {}

  logActivity(accepted ? "diff_accepted" : "diff_rejected", {
    filePath: diff.filePath,
    diffId: diffId,
    userEdited: userEdited,
  });
  refreshActivitySidebar();

  sendToServer({
    type: "diff_response",
    requestId: diff.requestId,
    accepted: accepted,
    userEdited: userEdited,
    finalContent: (accepted && userEdited) ? finalContent : undefined,
  });
}

// --- getCurrentSelection ---
function toolGetCurrentSelection() {
  var editor = nova.workspace.activeTextEditor;
  if (!editor) return { text: "", filePath: null, isEmpty: true };

  var range = editor.selectedRange;
  var text = editor.selectedText || "";
  var doc = editor.document;

  return {
    text: text,
    filePath: doc.path || null,
    startLine: 0,
    endLine: 0,
    startColumn: 0,
    endColumn: 0,
    isEmpty: range.length === 0,
  };
}

// --- getLatestSelection ---
function toolGetLatestSelection() {
  if (lastSelection) return lastSelection;
  return toolGetCurrentSelection();
}

// --- getOpenEditors ---
function toolGetOpenEditors() {
  var editors = nova.workspace.textEditors || [];
  return {
    editors: editors.map(function(editor) {
      return {
        filePath: editor.document.path || "untitled",
        isActive: editor === nova.workspace.activeTextEditor,
        isDirty: editor.document.isDirty || false,
        languageId: editor.document.syntax || "plaintext",
      };
    }),
  };
}

// --- getWorkspaceFolders ---
function toolGetWorkspaceFolders() {
  var wsPath = nova.workspace.path;
  return {
    folders: wsPath ? [{ uri: "file://" + wsPath, name: nova.path.basename(wsPath) }] : [],
  };
}

// --- checkDocumentDirty ---
function toolCheckDocumentDirty(args) {
  var editors = nova.workspace.textEditors || [];
  var editor = editors.find(function(e) { return e.document.path === args.filePath; });
  return {
    isDirty: editor ? (editor.document.isDirty || false) : false,
    filePath: args.filePath,
  };
}

// --- saveDocument ---
async function toolSaveDocument(args) {
  var editors = nova.workspace.textEditors || [];
  var editor = editors.find(function(e) { return e.document.path === args.filePath; });
  if (!editor) return { error: "File not open in editor" };

  try {
    await editor.save();
    return { success: true, filePath: args.filePath };
  } catch (err) {
    return { error: err.message };
  }
}

// --- getDiagnostics ---
function toolGetDiagnostics(args) {
  return {
    diagnostics: [],
    filePath: args.filePath || null,
  };
}

// --- closeAllDiffTabs ---
function toolCloseAllDiffTabs() {
  try {
    var tmpDir = nova.path.join(nova.extension.globalStoragePath, "diffs");
    if (nova.fs.stat(tmpDir)) {
      var items = nova.fs.listdir(tmpDir);
      for (var i = 0; i < items.length; i++) {
        try { nova.fs.remove(nova.path.join(tmpDir, items[i])); } catch (_) {}
      }
    }
  } catch (_) {}

  return { success: true };
}

// ---------------------------------------------------------------------------
// Selection tracking
// ---------------------------------------------------------------------------

function startSelectionTracking() {
  var tracker = nova.workspace.onDidAddTextEditor(function(editor) {
    setupEditorTracking(editor);
  });
  disposables.push(tracker);

  var editors = nova.workspace.textEditors || [];
  for (var i = 0; i < editors.length; i++) {
    setupEditorTracking(editors[i]);
  }
}

function setupEditorTracking(editor) {
  var selDisposable = editor.onDidChangeSelection(function(changedEditor) {
    var selection = buildSelectionData(changedEditor);
    if (selection) {
      lastSelection = selection;
      sendToServer({ type: "selection_update", data: selection });
    }
  });
  disposables.push(selDisposable);
}

function buildSelectionData(editor) {
  if (!editor || !editor.document) return null;

  var range = editor.selectedRange;
  var text = editor.selectedText || "";
  var doc = editor.document;

  return {
    filePath: doc.path || null,
    text: text,
    startLine: 0,
    endLine: 0,
    isEmpty: range.length === 0,
    syntax: doc.syntax || "plaintext",
  };
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function sendSelectionToContext(editor) {
  if (!editor) editor = nova.workspace.activeTextEditor;
  if (!editor) return;

  var selection = buildSelectionData(editor);
  if (selection && selection.text) {
    sendToServer({ type: "selection_update", data: selection });
    logActivity("selection_sent", { filePath: selection.filePath, length: selection.text.length });
    refreshActivitySidebar();
    showNotification("Sent", "Selection sent to Claude Code context.");
  } else {
    showNotification("No Selection", "Select some text first.");
  }
}

function addCurrentFile() {
  var editor = nova.workspace.activeTextEditor;
  if (!editor || !editor.document.path) {
    showNotification("No File", "No file is currently open.");
    return;
  }

  var filePath = editor.document.path;
  var content = editor.document.getTextInRange(new Range(0, editor.document.length));

  sendToServer({
    type: "selection_update",
    data: {
      filePath: filePath,
      text: content,
      startLine: 0,
      endLine: 0,
      isEmpty: false,
      syntax: editor.document.syntax || "plaintext",
      isWholeFile: true,
    },
  });

  logActivity("file_added", { filePath: filePath, length: content.length });
  refreshActivitySidebar();
  showNotification("File Added", nova.path.basename(filePath) + " added to Claude context.");
}

function showStatus() {
  var lines = [
    "Claude Code Bridge Status",
    "------------------------",
    "Server: " + (serverProcess ? "Running" : "Stopped"),
    "Port: " + (serverPort || "N/A"),
    "Connected clients: " + clientCount,
    "Workspace: " + (nova.workspace.path || "N/A"),
  ];

  var notification = new NotificationRequest("claudecode-status");
  notification.title = "Claude Code Bridge";
  notification.body = lines.join("\n");
  notification.actions = serverProcess ? ["Stop Bridge", "OK"] : ["Start Bridge", "OK"];

  nova.notifications.add(notification).then(function(response) {
    if (response.actionIdx === 0) {
      if (serverProcess) {
        stopBridge();
      } else {
        startBridge();
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Sidebar Data Providers
// ---------------------------------------------------------------------------

class StatusDataProvider {
  getChildren(element) {
    if (!element) {
      return [
        { id: "status", label: serverProcess ? "● Server Running" : "○ Server Stopped" },
        { id: "port", label: "Port: " + (serverPort || "—") },
        { id: "clients", label: "Clients: " + clientCount },
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
      return pendingDiffs.map(function(d) { return { kind: "diff", data: d }; });
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
      item.descriptiveText = relativeTime(d.openedAt);
      item.tooltip = d.filePath + "\nProposed " + new Date(d.openedAt).toLocaleString();
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
      var items = activityLog.map(function(e) { return { kind: "activity", data: e }; });
      items.push({ kind: "group", id: "toolcalls", label: "Tool Calls (" + toolCallLog.length + ")" });
      return items;
    }
    if (element.kind === "group" && element.id === "toolcalls") {
      return toolCallLog.map(function(t) { return { kind: "toolcall", data: t }; });
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
      var item = new TreeItem(formatActivityLabel(e));
      item.identifier = e.id;
      item.descriptiveText = relativeTime(e.timestamp);
      item.tooltip = formatActivityTooltip(e);
      item.command = "claudecode.activityClick";
      return item;
    }
    if (element.kind === "toolcall") {
      var t = element.data;
      var item = new TreeItem(t.tool + (t.success ? "" : "  ✗"));
      item.identifier = t.id;
      item.descriptiveText = relativeTime(t.timestamp);
      item.tooltip = t.tool + " · " + new Date(t.timestamp).toLocaleString() + "\n" + t.argsPreview;
      return item;
    }
    return null;
  }
}

var sidebarProvider = null;
var sidebarTree = null;
var diffsProvider = null;
var diffsTree = null;
var activityProvider = null;
var activityTree = null;

function updateSidebar() {
  try {
    if (!sidebarProvider) {
      sidebarProvider = new StatusDataProvider();
      sidebarTree = new TreeView("claudecode.sidebar.status", {
        dataProvider: sidebarProvider,
      });
      disposables.push(sidebarTree);
    }
    sidebarTree.reload();
  } catch (err) {
    console.error("Claude Code Bridge: sidebar update failed:", err.message);
  }
}

function ensureActivitySidebars() {
  try {
    if (!diffsProvider) {
      diffsProvider = new PendingDiffsDataProvider();
      diffsTree = new TreeView("claudecode.sidebar.diffs", {
        dataProvider: diffsProvider,
      });
      disposables.push(diffsTree);
    }
    if (!activityProvider) {
      activityProvider = new ActivityDataProvider();
      activityTree = new TreeView("claudecode.sidebar.activity", {
        dataProvider: activityProvider,
      });
      disposables.push(activityTree);
    }
  } catch (err) {
    console.error("Claude Code Bridge: activity sidebar init failed:", err.message);
  }
}

// Reload both activity-related sections. Called after every event that
// changes activityLog / toolCallLog / pendingDiffs, plus on a 30s timer
// so relative timestamps ("2m ago") stay accurate.
function refreshActivitySidebar() {
  ensureActivitySidebars();
  try {
    if (diffsTree) diffsTree.reload();
    if (activityTree) activityTree.reload();
  } catch (_) {}
}

function startActivityRefreshTimer() {
  if (activityRefreshTimer) return;
  activityRefreshTimer = setInterval(refreshActivitySidebar, 30000);
}

function stopActivityRefreshTimer() {
  if (activityRefreshTimer) {
    clearInterval(activityRefreshTimer);
    activityRefreshTimer = null;
  }
}

// ---------------------------------------------------------------------------
// Activity logging
// ---------------------------------------------------------------------------

function logActivity(type, data) {
  activityLog.unshift(Object.assign({
    id: "act_" + Date.now() + "_" + Math.random().toString(36).slice(2, 6),
    type: type,
    timestamp: Date.now(),
  }, data || {}));
  if (activityLog.length > ACTIVITY_MAX) {
    activityLog.length = ACTIVITY_MAX;
  }
}

function logToolCall(tool, args, result) {
  var argsPreview;
  try { argsPreview = JSON.stringify(args); }
  catch (_) { argsPreview = "[unserializable]"; }
  if (argsPreview && argsPreview.length > 200) argsPreview = argsPreview.slice(0, 200) + "…";

  toolCallLog.unshift({
    id: "tc_" + Date.now() + "_" + Math.random().toString(36).slice(2, 6),
    tool: tool,
    timestamp: Date.now(),
    argsPreview: argsPreview,
    success: !(result && result.error),
  });
  if (toolCallLog.length > TOOLCALLS_MAX) {
    toolCallLog.length = TOOLCALLS_MAX;
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
    case "selection_sent": return "✂️  Sent selection from " + basename;
    case "diff_proposed":  return "⚠️  Diff proposed: " + basename;
    case "diff_accepted":  return "✓  Accepted diff: " + basename + (e.userEdited ? " (with your edits)" : "");
    case "diff_rejected":  return "✗  Rejected diff: " + basename;
    default:               return e.type + (basename !== "?" ? " · " + basename : "");
  }
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

// ---------------------------------------------------------------------------
// Sidebar commands — click-through, diff Accept/Reject, Clear
// ---------------------------------------------------------------------------

function activityClickHandler() {
  if (!activityTree) return;
  var sel = activityTree.selection;
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
  req.title = formatActivityLabel(e);
  req.body = formatActivityTooltip(e);
  req.actions = e.filePath ? ["Open File", "OK"] : ["OK"];
  nova.notifications.add(req).then(function(response) {
    if (e.filePath && response.actionIdx === 0) {
      nova.workspace.openFile(e.filePath).catch(function(_) {});
    }
  });
}

function diffAcceptHandler() {
  var diffId = currentSelectedDiffId();
  if (diffId) resolveDiff(diffId, true);
}

function diffRejectHandler() {
  var diffId = currentSelectedDiffId();
  if (diffId) resolveDiff(diffId, false);
}

function diffShowDetailsHandler() {
  var diffId = currentSelectedDiffId();
  if (!diffId) return;
  var diff = pendingDiffs.find(function(d) { return d.id === diffId; });
  if (!diff) return;
  var req = new NotificationRequest("claudecode-diff-details-" + diffId);
  req.title = "Diff: " + nova.path.basename(diff.filePath);
  req.body = diff.filePath +
             "\nProposed: " + new Date(diff.openedAt).toLocaleString() +
             "\nProposal length: " + diff.newContent.length + " characters" +
             "\nTab name: " + diff.tabName;
  req.actions = ["Open Proposed Tab", "Accept", "Reject", "Cancel"];
  nova.notifications.add(req).then(function(response) {
    if (response.actionIdx === 0) {
      nova.workspace.openFile(diff.tmpFile).catch(function(_) {});
    } else if (response.actionIdx === 1) {
      resolveDiff(diffId, true);
    } else if (response.actionIdx === 2) {
      resolveDiff(diffId, false);
    }
  });
}

// Extract the diffId from whichever item in the diffs tree is currently
// selected (the parent node OR one of its Accept/Reject children).
function currentSelectedDiffId() {
  if (!diffsTree) return null;
  var sel = diffsTree.selection;
  if (!sel || sel.length === 0) return null;
  var element = sel[0];
  if (!element) return null;
  if (element.kind === "diff") return element.data.id;
  if (element.kind === "diffAction") return element.diffId;
  return null;
}

function activityClearHandler() {
  activityLog = [];
  toolCallLog = [];
  refreshActivitySidebar();
  showNotification("Cleared", "Activity log cleared.");
}

function sidebarRefreshHandler() {
  updateSidebar();
  refreshActivitySidebar();
}

// ---------------------------------------------------------------------------
// Launch Claude Code with correct env vars
// ---------------------------------------------------------------------------
//
// Honours the claudecode.terminalApp setting:
//   • "auto"      — iTerm if installed, otherwise Terminal.app
//   • "iTerm"     — driven via AppleScript (new tab in current window if any)
//   • "Terminal"  — driven via AppleScript (do script in a new window)
//   • "clipboard" — copy the command, let the user paste it themselves
//
// Other terminals (Warp, Ghostty, Hyper) lack reliable AppleScript control,
// so they fall back to the clipboard path. That's documented as a Known
// Limitation in README §6/§7's neighbourhood.

async function launchClaude() {
  if (!serverPort) {
    showNotification("Not Ready", "Start the bridge first. The WebSocket server is not running.");
    return;
  }

  var workspace = nova.workspace.path || nova.environment["HOME"];
  var claudeCmd = nova.workspace.config.get("claudecode.claudeCommand") || "claude";
  var envPrefix = "CLAUDE_CODE_SSE_PORT=" + serverPort + " ENABLE_IDE_INTEGRATION=true";
  var fullCommand = "cd " + shellQuote(workspace) + " && " + envPrefix + " " + claudeCmd;

  var app = resolveTerminalApp();

  if (app === "clipboard") {
    nova.clipboard.writeText(fullCommand);
    showNotification("Copied", "Launch command copied to clipboard. Paste it in your terminal.");
    return;
  }

  if (!isAppInstalled(app)) {
    nova.clipboard.writeText(fullCommand);
    showNotification(
      "Terminal Not Found",
      app + ".app is not installed. Command copied to clipboard instead — pick another terminal in extension settings."
    );
    return;
  }

  var script = buildTerminalScript(app, fullCommand);
  try {
    await runAppleScript(script);
    showNotification("Launching", "Claude Code is starting in " + app + ". The IDE bridge will connect automatically.");
  } catch (err) {
    console.error("Claude Code Bridge: terminal launch failed:", err.message);
    nova.clipboard.writeText(fullCommand);
    showNotification(
      "Launch Failed",
      "Could not control " + app + ": " + err.message + "\nCommand copied to clipboard as fallback."
    );
  }
}

// Resolve the configured terminal, expanding the "auto" default.
function resolveTerminalApp() {
  var pref = nova.config.get("claudecode.terminalApp") || "auto";
  if (pref !== "auto") return pref;
  return isAppInstalled("iTerm") ? "iTerm" : "Terminal";
}

// Quick existence check via /Applications and ~/Applications.
function isAppInstalled(name) {
  var candidates = [
    "/Applications/" + name + ".app",
    nova.environment["HOME"] + "/Applications/" + name + ".app",
  ];
  for (var i = 0; i < candidates.length; i++) {
    try { if (nova.fs.stat(candidates[i])) return true; } catch (_) {}
  }
  return false;
}

// AppleScript driver for the supported terminals. The whole command is
// passed as a single AppleScript string literal, so Terminal/iTerm execute
// it in one shot — no extra shell escaping needed beyond the workspace path
// (which we shell-quote in the caller via shellQuote).
function buildTerminalScript(app, fullCommand) {
  var commandAS = applescriptStringLiteral(fullCommand);
  if (app === "iTerm") {
    return [
      'tell application "iTerm"',
      '  activate',
      '  if (count of windows) = 0 then',
      '    create window with default profile',
      '  else',
      '    tell current window to create tab with default profile',
      '  end if',
      '  tell current session of current window',
      '    write text ' + commandAS,
      '  end tell',
      'end tell',
    ].join("\n");
  }
  return [
    'tell application "Terminal"',
    '  activate',
    '  do script ' + commandAS,
    'end tell',
  ].join("\n");
}

// Run an AppleScript via osascript. We write the script to a temp file
// rather than passing it via -e to avoid double-quoting hell when the
// workspace path or the configured claude command contains quotes.
function runAppleScript(script) {
  return new Promise(function(resolve, reject) {
    var tmpDir = nova.path.join(nova.extension.globalStoragePath, "scripts");
    try { nova.fs.mkdir(tmpDir); } catch (_) {}
    var tmpFile = nova.path.join(tmpDir, "as_" + Date.now() + ".applescript");

    try {
      var f = nova.fs.open(tmpFile, "w");
      f.write(script);
      f.close();
    } catch (err) {
      reject(err);
      return;
    }

    var proc;
    try {
      proc = new Process("/usr/bin/osascript", { args: [tmpFile] });
    } catch (err) {
      try { nova.fs.remove(tmpFile); } catch (_) {}
      reject(err);
      return;
    }

    var stderr = "";
    proc.onStderr(function(d) { stderr += d; });
    proc.onDidExit(function(code) {
      try { nova.fs.remove(tmpFile); } catch (_) {}
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || ("osascript exited with code " + code)));
    });

    try { proc.start(); }
    catch (err) {
      try { nova.fs.remove(tmpFile); } catch (_) {}
      reject(err);
    }
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function showNotification(title, body) {
  var req = new NotificationRequest("claudecode-" + Date.now());
  req.title = "Claude Code: " + title;
  req.body = body;
  nova.notifications.add(req);
}

function delay(ms) {
  return new Promise(function(resolve) { setTimeout(resolve, ms); });
}

// POSIX-safe single-quoted shell literal. Handles spaces and embedded
// quotes in workspace paths.
function shellQuote(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

// AppleScript double-quoted string literal. Backslash and double-quote are
// the only characters that need escaping inside an AppleScript "..." literal.
function applescriptStringLiteral(s) {
  return '"' + String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}
