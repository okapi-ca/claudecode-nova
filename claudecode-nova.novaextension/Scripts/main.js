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
let statusItem = null;
let disposables = [];
let selectionTracker = null;
let lastSelection = null;
let stdinWriter = null;

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

exports.activate = function() {
  console.log("Claude Code Bridge: activating…");

  // Register commands
  disposables.push(
    nova.commands.register("claudecode.start", startBridge),
    nova.commands.register("claudecode.stop", stopBridge),
    nova.commands.register("claudecode.sendSelection", sendSelectionToContext),
    nova.commands.register("claudecode.addFile", addCurrentFile),
    nova.commands.register("claudecode.status", showStatus),
  );

  // Auto-start if configured
  const autoStart = nova.config.get("claudecode.autoStart");
  if (autoStart !== false) {
    startBridge();
  }
};

exports.deactivate = function() {
  console.log("Claude Code Bridge: deactivating…");
  stopBridge();
  for (const d of disposables) {
    d.dispose();
  }
  disposables = [];
};

// ---------------------------------------------------------------------------
// Bridge lifecycle
// ---------------------------------------------------------------------------

function startBridge() {
  if (serverProcess) {
    console.log("Claude Code Bridge: already running");
    showNotification("Already Running", "Claude Code Bridge is already active.");
    return;
  }

  const nodePath = nova.config.get("claudecode.nodePath") || "node";
  const portMin  = nova.config.get("claudecode.portMin") || 10000;
  const portMax  = nova.config.get("claudecode.portMax") || 65535;
  const workspace = nova.workspace.path || nova.path.join(nova.environment.HOME, "Desktop");

  const scriptPath = nova.path.join(nova.extension.path, "Scripts", "ws-server.js");

  console.log(`Claude Code Bridge: starting server via ${nodePath}`);
  console.log(`  Script: ${scriptPath}`);
  console.log(`  Workspace: ${workspace}`);

  serverProcess = new Process(nodePath, {
    args: [scriptPath],
    env: {
      CC_PORT_MIN: String(portMin),
      CC_PORT_MAX: String(portMax),
      CC_WORKSPACE: workspace,
    },
    cwd: workspace,
    stdio: "pipe",
  });

  // Read JSON lines from server stdout
  serverProcess.onStdout(function(line) {
    if (!line.trim()) return;
    try {
      handleServerMessage(JSON.parse(line.trim()));
    } catch (err) {
      console.error("Claude Code Bridge: failed to parse server message:", line);
    }
  });

  serverProcess.onStderr(function(line) {
    console.warn("Claude Code Bridge [server stderr]:", line);
  });

  serverProcess.onDidExit(function(exitCode) {
    console.log(`Claude Code Bridge: server exited with code ${exitCode}`);
    serverProcess = null;
    serverPort = null;
    isConnected = false;
    clientCount = 0;
    stopSelectionTracking();
    updateSidebar();
  });

  serverProcess.start();

  // Start tracking editor selection
  const trackSelection = nova.config.get("claudecode.trackSelection");
  if (trackSelection !== false) {
    startSelectionTracking();
  }

  showNotification("Starting", "Claude Code Bridge is starting…");
}

function stopBridge() {
  stopSelectionTracking();

  if (serverProcess) {
    console.log("Claude Code Bridge: stopping server…");
    serverProcess.terminate();
    serverProcess = null;
    serverPort = null;
    isConnected = false;
    clientCount = 0;
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
    const writer = serverProcess.stdin.getWriter();
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
      console.log(`Claude Code Bridge: server started on port ${msg.port}`);
      showNotification(
        "Ready",
        `WebSocket MCP server on port ${msg.port}.\nRun "claude" then "/ide" to connect.`
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
        console.error(`[ws-server] ${msg.message}`);
      } else {
        console.log(`[ws-server] ${msg.message}`);
      }
      break;
  }
}

// ---------------------------------------------------------------------------
// MCP Tool handlers — mapping Claude Code tools to Nova APIs
// ---------------------------------------------------------------------------

async function handleToolCall(msg) {
  const { requestId, tool, arguments: args } = msg;
  let result;

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
        result = { error: `Unknown tool: ${tool}` };
    }
  } catch (err) {
    console.error(`Claude Code Bridge: tool error [${tool}]:`, err.message);
    result = { error: err.message };
  }

  sendToServer({ type: "tool_result", requestId, result });
}

// --- openFile ---
async function toolOpenFile(args) {
  const filePath = args.filePath;
  if (!filePath) return { error: "filePath is required" };

  try {
    await nova.workspace.openFile(filePath);

    if (args.lineNumber) {
      // Wait a bit for the editor to open, then scroll to line
      await delay(100);
      const editor = nova.workspace.activeTextEditor;
      if (editor && editor.document.path === filePath) {
        const line = Math.max(0, args.lineNumber - 1);
        const range = new Range(
          editor.document.getLineRangeForRange(new Range(line, line)).start,
          editor.document.getLineRangeForRange(new Range(line, line)).start
        );
        editor.selectedRange = range;
        editor.scrollToCursorPosition();
      }
    }

    return { success: true, filePath };
  } catch (err) {
    return { error: err.message };
  }
}

// --- openDiff ---
async function toolOpenDiff(args, requestId) {
  const { filePath, oldContent, newContent, tabName } = args;

  // Nova doesn't have a native diff API like VS Code.
  // Strategy: write proposed content to a temp file, then open both side by side.
  // We'll use a notification to let the user accept/reject.

  try {
    const tmpDir = nova.path.join(nova.extension.globalStoragePath, "diffs");
    nova.fs.mkdir(tmpDir);
    const tmpFile = nova.path.join(tmpDir, `proposed_${Date.now()}_${nova.path.basename(filePath)}`);
    
    // Write proposed content to temp file
    const file = nova.fs.open(tmpFile, "w");
    file.write(newContent);
    file.close();

    // Open the original file
    await nova.workspace.openFile(filePath);
    
    // Open the proposed file
    await nova.workspace.openFile(tmpFile);

    // Show accept/reject notification
    const notification = new NotificationRequest("claudecode-diff");
    notification.title = "Claude Code Diff";
    notification.body = `Review changes for ${nova.path.basename(filePath)}.\n` +
      `Proposed changes are open in a new tab (${tabName || "proposed"}).`;
    notification.actions = ["Accept Changes", "Reject"];

    nova.notifications.add(notification).then((response) => {
      const accepted = response.actionIdx === 0;

      if (accepted) {
        // Apply: write newContent to original file
        try {
          const outFile = nova.fs.open(filePath, "w");
          outFile.write(newContent);
          outFile.close();
          console.log(`Claude Code Bridge: accepted diff for ${filePath}`);
        } catch (err) {
          console.error("Claude Code Bridge: failed to apply diff:", err.message);
        }
      }

      // Clean up temp file
      try { nova.fs.remove(tmpFile); } catch (_) {}

      // Send response back to server
      sendToServer({ type: "diff_response", requestId, accepted });
    });

  } catch (err) {
    sendToServer({
      type: "tool_result",
      requestId,
      result: { error: err.message },
    });
  }
}

// --- getCurrentSelection ---
function toolGetCurrentSelection() {
  const editor = nova.workspace.activeTextEditor;
  if (!editor) return { text: "", filePath: null, isEmpty: true };

  const range = editor.selectedRange;
  const text = editor.selectedText || "";
  const doc = editor.document;

  return {
    text,
    filePath: doc.path || null,
    startLine: doc.lineAtPosition ? doc.lineAtPosition(range.start) : 0,
    endLine: doc.lineAtPosition ? doc.lineAtPosition(range.end) : 0,
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
  const editors = nova.workspace.textEditors || [];
  return {
    editors: editors.map((editor) => ({
      filePath: editor.document.path || "untitled",
      isActive: editor === nova.workspace.activeTextEditor,
      isDirty: editor.document.isDirty || false,
      languageId: editor.document.syntax || "plaintext",
    })),
  };
}

// --- getWorkspaceFolders ---
function toolGetWorkspaceFolders() {
  const path = nova.workspace.path;
  return {
    folders: path ? [{ uri: `file://${path}`, name: nova.path.basename(path) }] : [],
  };
}

// --- checkDocumentDirty ---
function toolCheckDocumentDirty(args) {
  const editors = nova.workspace.textEditors || [];
  const editor = editors.find((e) => e.document.path === args.filePath);
  return {
    isDirty: editor ? (editor.document.isDirty || false) : false,
    filePath: args.filePath,
  };
}

// --- saveDocument ---
async function toolSaveDocument(args) {
  const editors = nova.workspace.textEditors || [];
  const editor = editors.find((e) => e.document.path === args.filePath);
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
  // Nova doesn't expose a global diagnostics API directly.
  // Extensions typically use IssueCollection. We return what we can.
  // In a full implementation, we'd maintain our own IssueCollection from LSP.
  return {
    diagnostics: [],
    filePath: args.filePath || null,
    note: "Diagnostics integration requires LSP extension cooperation. Coming in a future version.",
  };
}

// --- closeAllDiffTabs ---
function toolCloseAllDiffTabs() {
  // Clean up temp diff files
  try {
    const tmpDir = nova.path.join(nova.extension.globalStoragePath, "diffs");
    if (nova.fs.stat(tmpDir)) {
      const items = nova.fs.listdir(tmpDir);
      for (const item of items) {
        try { nova.fs.remove(nova.path.join(tmpDir, item)); } catch (_) {}
      }
    }
  } catch (_) {}

  return { success: true };
}

// ---------------------------------------------------------------------------
// Selection tracking
// ---------------------------------------------------------------------------

function startSelectionTracking() {
  stopSelectionTracking();

  // Track active editor changes
  const tracker = nova.workspace.onDidAddTextEditor(function(editor) {
    setupEditorTracking(editor);
  });
  disposables.push(tracker);

  // Track existing editors
  const editors = nova.workspace.textEditors || [];
  for (const editor of editors) {
    setupEditorTracking(editor);
  }
}

function setupEditorTracking(editor) {
  const selDisposable = editor.onDidChangeSelection(function(changedEditor) {
    const selection = buildSelectionData(changedEditor);
    if (selection) {
      lastSelection = selection;
      sendToServer({ type: "selection_update", data: selection });
    }
  });
  disposables.push(selDisposable);
}

function buildSelectionData(editor) {
  if (!editor || !editor.document) return null;

  const range = editor.selectedRange;
  const text = editor.selectedText || "";
  const doc = editor.document;

  return {
    filePath: doc.path || null,
    text,
    startLine: 0,   // Nova Range is character-based; line mapping is approximate
    endLine: 0,
    isEmpty: range.length === 0,
    syntax: doc.syntax || "plaintext",
  };
}

function stopSelectionTracking() {
  // Selection disposables are in the main disposables array;
  // they'll be cleaned up on deactivation.
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function sendSelectionToContext(editor) {
  if (!editor) editor = nova.workspace.activeTextEditor;
  if (!editor) return;

  const selection = buildSelectionData(editor);
  if (selection && selection.text) {
    sendToServer({ type: "selection_update", data: selection });
    showNotification("Sent", "Selection sent to Claude Code context.");
  } else {
    showNotification("No Selection", "Select some text first.");
  }
}

function addCurrentFile(workspace) {
  const editor = nova.workspace.activeTextEditor;
  if (!editor || !editor.document.path) {
    showNotification("No File", "No file is currently open.");
    return;
  }

  const filePath = editor.document.path;
  const content = editor.document.getTextInRange(new Range(0, editor.document.length));

  sendToServer({
    type: "selection_update",
    data: {
      filePath,
      text: content,
      startLine: 0,
      endLine: 0,
      isEmpty: false,
      syntax: editor.document.syntax || "plaintext",
      isWholeFile: true,
    },
  });

  showNotification("File Added", `${nova.path.basename(filePath)} added to Claude context.`);
}

function showStatus() {
  const lines = [
    `Claude Code Bridge Status`,
    `━━━━━━━━━━━━━━━━━━━━━━━━`,
    `Server: ${serverProcess ? "Running" : "Stopped"}`,
    `Port: ${serverPort || "N/A"}`,
    `Connected clients: ${clientCount}`,
    `Workspace: ${nova.workspace.path || "N/A"}`,
  ];

  const notification = new NotificationRequest("claudecode-status");
  notification.title = "Claude Code Bridge";
  notification.body = lines.join("\n");
  notification.actions = serverProcess ? ["Stop Bridge", "OK"] : ["Start Bridge", "OK"];

  nova.notifications.add(notification).then((response) => {
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

// Note: Nova sidebars use TreeDataProvider. This is a minimal implementation.
// A full version would show connection status, open files, and diagnostics.

class StatusDataProvider {
  getChildren(element) {
    if (!element) {
      return [
        { id: "status", label: serverProcess ? "● Server Running" : "○ Server Stopped" },
        { id: "port", label: `Port: ${serverPort || "—"}` },
        { id: "clients", label: `Clients: ${clientCount}` },
      ];
    }
    return [];
  }

  getTreeItem(element) {
    const item = new TreeItem(element.label);
    item.identifier = element.id;
    return item;
  }
}

let sidebarProvider = null;
let sidebarTree = null;

function updateSidebar() {
  if (!sidebarProvider) {
    sidebarProvider = new StatusDataProvider();
    sidebarTree = new TreeView("claudecode.sidebar.status", {
      dataProvider: sidebarProvider,
    });
    disposables.push(sidebarTree);
  }
  sidebarTree.reload();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function showNotification(title, body) {
  const req = new NotificationRequest("claudecode-" + Date.now());
  req.title = `Claude Code: ${title}`;
  req.body = body;
  nova.notifications.add(req);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
