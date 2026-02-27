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
    );
    console.log("Claude Code Bridge: commands registered");
  } catch (err) {
    console.error("Claude Code Bridge: failed to register commands:", err.message);
    return;
  }

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
        result = await toolOpenDiff(args, requestId);
        return; // openDiff sends its own deferred response
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

    var notification = new NotificationRequest("claudecode-diff");
    notification.title = "Claude Code Diff";
    notification.body = "Review changes for " + nova.path.basename(filePath) + ".\nProposed changes are open in a new tab (" + (tabName || "proposed") + ").";
    notification.actions = ["Accept Changes", "Reject"];

    nova.notifications.add(notification).then(function(response) {
      var accepted = response.actionIdx === 0;

      if (accepted) {
        try {
          var outFile = nova.fs.open(filePath, "w");
          outFile.write(newContent);
          outFile.close();
          console.log("Claude Code Bridge: accepted diff for " + filePath);
        } catch (err) {
          console.error("Claude Code Bridge: failed to apply diff:", err.message);
        }
      }

      try { nova.fs.remove(tmpFile); } catch (_) {}
      sendToServer({ type: "diff_response", requestId: requestId, accepted: accepted });
    });

  } catch (err) {
    sendToServer({
      type: "tool_result",
      requestId: requestId,
      result: { error: err.message },
    });
  }
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
// Sidebar DataProvider
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

var sidebarProvider = null;
var sidebarTree = null;

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

// ---------------------------------------------------------------------------
// Launch Claude Code with correct env vars
// ---------------------------------------------------------------------------

function launchClaude() {
  if (!serverPort) {
    showNotification("Not Ready", "Start the bridge first. The WebSocket server is not running.");
    return;
  }

  var claudeCmd = nova.workspace.config.get("claudecode.claudeCommand") || "claude";
  var command = "CLAUDE_CODE_SSE_PORT=" + serverPort + " ENABLE_IDE_INTEGRATION=true " + claudeCmd;

  var notification = new NotificationRequest("claudecode-launch");
  notification.title = "Launch Claude Code";
  notification.body = "Run this in your terminal:\n\n" + command;
  notification.actions = ["Copy Command", "OK"];
  nova.notifications.add(notification).then(function(response) {
    if (response.actionIdx === 0) {
      nova.clipboard.writeText(command);
      showNotification("Copied", "Command copied to clipboard. Paste it in your terminal.");
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
