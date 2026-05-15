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
let activityPersistTimer = null;
const ACTIVITY_PERSIST_DEBOUNCE_MS = 1000;

// Git branch cache. Refreshed on bridge start, after notable events, and on
// a 5-minute interval. Sent in selection_update payloads and surfaced in
// getWorkspaceFolders so Claude can mention "you're on feature/foo" without
// having to call out to git itself.
let gitBranch = null;
let gitBranchTimer = null;
const GIT_BRANCH_REFRESH_MS = 5 * 60 * 1000;

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

exports.activate = function() {
  console.log("Claude Code Bridge: activate() called");

  try {
    disposables.push(
      nova.commands.register("claudecode.start", startBridge),
      nova.commands.register("claudecode.stop", stopBridge),
      nova.commands.register("claudecode.restart", restartBridge),
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

  // Restore the persisted activity log (best-effort) before any UI renders,
  // so reopening Nova doesn't wipe the user's recent context.
  loadActivityLog();

  // Pre-build the activity sidebars so they render immediately
  // (placeholder text) instead of staying blank until the first event.
  ensureActivitySidebars();
  startActivityRefreshTimer();
  startGitBranchRefresh();

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
  stopGitBranchRefresh();
  flushActivityLog();
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

  // Refresh the git branch cache now so it's already populated for the
  // first selection_update / getWorkspaceFolders call.
  refreshGitBranch();

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

// Stop + start with a short delay so the OS releases the port before we rebind.
// Useful after changing the port range or the Node.js path.
function restartBridge() {
  var wasRunning = !!serverProcess;
  stopBridge();
  setTimeout(function() {
    try {
      startBridge();
      if (wasRunning) {
        showNotification("Restarted", "Claude Code Bridge has been restarted.");
      }
    } catch (err) {
      console.error("Claude Code Bridge: restart failed:", err.message);
      showNotification("Restart Failed", err.message);
    }
  }, 300);
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
      case "close_tab":
        result = toolCloseTab(args);
        break;
      case "closeAllDiffTabs":
        result = toolCloseAllDiffTabs();
        break;
      case "executeCode":
        result = toolExecuteCode(args);
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
//
// Schema per PROTOCOL.md: {filePath, preview, startText, endText,
// selectToEndOfLine, makeFrontmost}. Nova does not expose a real preview
// mode (`preview` is accepted but ignored — file always opens normally) and
// openFile() always focuses the new editor, so `makeFrontmost: false` is
// best-effort and only changes the response shape, not the side effects.
async function toolOpenFile(args) {
  var filePath = args.filePath;
  if (!filePath) return { error: "filePath is required" };

  var makeFrontmost = args.makeFrontmost !== false;  // default true
  var startText = args.startText;
  var endText = args.endText;
  var selectToEndOfLine = !!args.selectToEndOfLine;

  try {
    var editor = await nova.workspace.openFile(filePath);

    // The openFile() Promise sometimes resolves before the editor is fully
    // ready — re-fetch from active editor as a safety net.
    if (!editor || !editor.document || editor.document.path !== filePath) {
      await delay(100);
      editor = nova.workspace.activeTextEditor;
    }

    // Pattern-based selection (startText … endText). Both required to apply.
    if (editor && editor.document && startText && endText) {
      var doc = editor.document;
      var fullText = doc.getTextInRange(new Range(0, doc.length));
      var startIdx = fullText.indexOf(startText);
      var endIdx = startIdx >= 0 ? fullText.indexOf(endText, startIdx + startText.length) : -1;
      if (startIdx >= 0 && endIdx >= 0) {
        var selEnd = endIdx + endText.length;
        if (selectToEndOfLine) {
          var lineRange = doc.getLineRangeForRange(new Range(selEnd, selEnd));
          selEnd = lineRange.end;
        }
        editor.selectedRange = new Range(startIdx, selEnd);
        editor.scrollToCursorPosition();
      }
    }

    if (makeFrontmost) {
      return "Opened file: " + filePath;
    }

    // makeFrontmost=false response carries doc metadata. lineCount is computed
    // by counting LF chars (cheap; same approach as offsetToPosition).
    var lineCount = 0;
    if (editor && editor.document) {
      var text = editor.document.getTextInRange(new Range(0, editor.document.length));
      lineCount = 1;
      for (var i = 0; i < text.length; i++) {
        if (text.charCodeAt(i) === 10) lineCount++;
      }
    }
    return {
      success: true,
      filePath: filePath,
      languageId: (editor && editor.document && editor.document.syntax) || "plaintext",
      lineCount: lineCount,
    };
  } catch (err) {
    return { error: err.message };
  }
}

// --- openDiff ---
//
// Schema per PROTOCOL.md: {old_file_path, new_file_path, new_file_contents,
// tab_name}. Most calls use old_file_path === new_file_path (in-place edit);
// when they differ, we treat new_file_path as the write target on Accept.
//
// Stages the proposed change as a temp file alongside the original, registers
// it in pendingDiffs so the sidebar can show it, and posts an Accept/Reject
// notification. Either path (notification button OR sidebar command) ends up
// calling resolveDiff(diffId, accepted).
async function toolOpenDiff(args, requestId) {
  var oldPath = args.old_file_path;
  var newPath = args.new_file_path || oldPath;
  var newContent = args.new_file_contents;
  var tabName = args.tab_name;

  // Internal name: `filePath` is the write target on accept (i.e. new_file_path).
  var filePath = newPath;

  try {
    var tmpDir = nova.path.join(nova.extension.globalStoragePath, "diffs");
    try { nova.fs.mkdir(tmpDir); } catch (_) {}
    var tmpFile = nova.path.join(tmpDir, "proposed_" + Date.now() + "_" + nova.path.basename(filePath));

    var file = nova.fs.open(tmpFile, "w");
    file.write(newContent);
    file.close();

    // Open the original (oldPath) so the user has the "before" tab in view,
    // then the proposed-changes tmp file. If old/new differ (rename case),
    // newPath may not exist on disk yet — openFile errors are non-fatal here.
    try { await nova.workspace.openFile(oldPath); } catch (_) {}
    await nova.workspace.openFile(tmpFile);

    // Cheap line-count delta. Not a real LCS diff — just enough so the user
    // can spot a 200-line rewrite vs. a 3-line tweak at a glance. Read the
    // ORIGINAL file (oldPath) from disk: best-effort, missing file = new file
    // = all add.
    var stats = computeDiffStats(oldPath, newContent);

    var diffId = "diff_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);
    pendingDiffs.unshift({
      id: diffId,
      filePath: filePath,
      tmpFile: tmpFile,
      newContent: newContent,
      tabName: tabName || "proposed",
      requestId: requestId,
      openedAt: Date.now(),
      stats: stats,
    });
    logActivity("diff_proposed", { filePath: filePath, diffId: diffId, stats: stats });
    refreshActivitySidebar();

    var notification = new NotificationRequest("claudecode-diff-" + diffId);
    notification.title = "Claude Code Diff";
    notification.body = "Review changes for " + nova.path.basename(filePath) + " (" + formatStats(stats) + ").\nProposed changes are open in a new tab (" + (tabName || "proposed") + ").";
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

// Convert a character offset into a 0-indexed (line, column) position by
// reading the prefix up to the offset and counting newlines. Nova's Range
// is character-offset based and exposes no direct line API, so this is the
// only path. Cost is O(offset) — fine for normal source files; if perf
// becomes an issue on huge documents we can cache (offset → line) per doc
// version.
function offsetToPosition(doc, offset) {
  if (!doc || offset <= 0) return { line: 0, column: 0 };
  var clamped = Math.min(offset, doc.length);
  var prefix = doc.getTextInRange(new Range(0, clamped));
  var line = 0;
  var lastNewline = -1;
  for (var i = 0; i < prefix.length; i++) {
    if (prefix.charCodeAt(i) === 10) {
      line++;
      lastNewline = i;
    }
  }
  return { line: line, column: clamped - lastNewline - 1 };
}

// --- getCurrentSelection ---
function toolGetCurrentSelection() {
  var editor = nova.workspace.activeTextEditor;
  if (!editor) return { text: "", filePath: null, isEmpty: true };

  var range = editor.selectedRange;
  var text = editor.selectedText || "";
  var doc = editor.document;
  var startPos = offsetToPosition(doc, range.start);
  var endPos = offsetToPosition(doc, range.end);

  return {
    text: text,
    filePath: doc.path || null,
    startLine: startPos.line,
    endLine: endPos.line,
    startColumn: startPos.column,
    endColumn: endPos.column,
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
    gitBranch: gitBranch,
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
//
// Spec returns an array of {uri, diagnostics: [...]} entries. Nova has no
// LSP/diagnostics public API, so we always return an empty diagnostics list,
// but with the spec-shaped envelope so Claude's deserialization succeeds.
function toolGetDiagnostics(args) {
  var uri = args && args.uri ? args.uri : null;
  return uri ? [{ uri: uri, diagnostics: [] }] : [];
}

// --- close_tab ---
//
// Spec asks for "TAB_CLOSED" on success. Nova has no public close-tab API,
// so this is a no-op that still reports success — keeps the protocol contract
// even though the editor tab stays open.
function toolCloseTab(args) {
  return "TAB_CLOSED";
}

// --- executeCode ---
//
// Jupyter kernel execution. Nova doesn't ship a notebook runtime, so we
// surface a clear error rather than silently no-op'ing — Claude will see
// isError=true and know not to retry.
function toolExecuteCode(args) {
  return { error: "executeCode is not supported in Nova (no Jupyter kernel)" };
}

// --- closeAllDiffTabs ---
//
// Reject every still-pending diff first — otherwise Claude is stuck waiting
// on a `diff_response` for a requestId we've thrown away — then sweep the
// temp-file directory. The Nova editor tabs themselves stay open (no public
// tab-close API), but the underlying state is now consistent.
function toolCloseAllDiffTabs() {
  var rejected = 0;
  // Snapshot first: resolveDiff() mutates pendingDiffs in place.
  var snapshot = pendingDiffs.slice();
  for (var i = 0; i < snapshot.length; i++) {
    try {
      resolveDiff(snapshot[i].id, false);
      rejected++;
    } catch (err) {
      console.error("Claude Code Bridge: failed to reject diff during closeAllDiffTabs:", err.message);
    }
  }

  try {
    var tmpDir = nova.path.join(nova.extension.globalStoragePath, "diffs");
    if (nova.fs.stat(tmpDir)) {
      var items = nova.fs.listdir(tmpDir);
      for (var j = 0; j < items.length; j++) {
        try { nova.fs.remove(nova.path.join(tmpDir, items[j])); } catch (_) {}
      }
    }
  } catch (_) {}

  // Spec wire format: plain string "CLOSED_${count}_DIFF_TABS".
  return "CLOSED_" + rejected + "_DIFF_TABS";
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
  var startPos = offsetToPosition(doc, range.start);
  var endPos = offsetToPosition(doc, range.end);

  return {
    filePath: doc.path || null,
    text: text,
    startLine: startPos.line,
    endLine: endPos.line,
    startColumn: startPos.column,
    endColumn: endPos.column,
    isEmpty: range.length === 0,
    syntax: doc.syntax || "plaintext",
    gitBranch: gitBranch,
  };
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function sendSelectionToContext(editor) {
  if (!editor) editor = nova.workspace.activeTextEditor;
  if (!editor) return;

  // Save first if dirty so Claude sees the same content the user does. The
  // selection text comes from the in-memory buffer regardless, but file-path
  // references on Claude's side are read from disk — keep them aligned.
  if (editor.document.isDirty && editor.document.path) {
    try { await editor.save(); }
    catch (err) { console.warn("Claude Code Bridge: auto-save before send failed:", err.message); }
  }

  var selection = buildSelectionData(editor);
  if (selection && selection.text) {
    // Update getCurrentSelection state on Claude's side
    sendToServer({ type: "selection_update", data: selection });
    // Add the selection to Claude's context (the actual "@file:lines" mechanism)
    if (selection.filePath) {
      sendToServer({
        type: "at_mention",
        data: {
          filePath: selection.filePath,
          lineStart: selection.startLine,
          lineEnd: selection.endLine,
        },
      });
    }
    logActivity("selection_sent", {
      filePath: selection.filePath,
      length: selection.text.length,
      startLine: selection.startLine,
      endLine: selection.endLine,
    });
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

  // Send ONLY the @-mention (without lineStart/lineEnd → whole file). Sending
  // a selection_update alongside would confuse Claude, which would interpret
  // the (0,0) line range as "0 lines selected" and truncate the context.
  sendToServer({
    type: "at_mention",
    data: {
      filePath: filePath,
    },
  });

  logActivity("file_added", { filePath: filePath, length: editor.document.length });
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
      item.tooltip = buildDiffTooltip(d);
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
  activityRefreshTimer = setInterval(activityTick, 30000);
}

function stopActivityRefreshTimer() {
  if (activityRefreshTimer) {
    clearInterval(activityRefreshTimer);
    activityRefreshTimer = null;
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
  var stale = pendingDiffs.filter(function(d) { return d.openedAt < cutoff; });
  for (var i = 0; i < stale.length; i++) {
    console.log("Claude Code Bridge: auto-rejecting stale diff for " + stale[i].filePath);
    try { resolveDiff(stale[i].id, false); } catch (_) {}
  }
}

// ---------------------------------------------------------------------------
// Git branch tracking
// ---------------------------------------------------------------------------
//
// `git rev-parse --abbrev-ref HEAD` gives us the current branch (or "HEAD"
// if detached). We cache the result and refresh on bridge start, after the
// 5-minute interval, and on demand. The cached value is included in
// selection_update payloads (cheap, just a string) and in
// getWorkspaceFolders.

function startGitBranchRefresh() {
  refreshGitBranch();
  if (gitBranchTimer) return;
  gitBranchTimer = setInterval(refreshGitBranch, GIT_BRANCH_REFRESH_MS);
}

function stopGitBranchRefresh() {
  if (gitBranchTimer) {
    clearInterval(gitBranchTimer);
    gitBranchTimer = null;
  }
}

function refreshGitBranch() {
  var workspace = nova.workspace.path;
  if (!workspace) {
    gitBranch = null;
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
      if (branch && branch !== gitBranch) {
        console.log("Claude Code Bridge: git branch = " + branch);
      }
      gitBranch = branch || null;
    } else {
      // Not a git repo, or git not installed. Stay quiet.
      gitBranch = null;
    }
  });
  try { proc.start(); } catch (_) { gitBranch = null; }
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
  scheduleActivityPersist();
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
      activityLog = parsed.activityLog.slice(0, ACTIVITY_MAX);
    }
    if (Array.isArray(parsed.toolCallLog)) {
      toolCallLog = parsed.toolCallLog.slice(0, TOOLCALLS_MAX);
    }
    console.log("Claude Code Bridge: restored activity log (" +
      activityLog.length + " events, " + toolCallLog.length + " tool calls)");
  } catch (err) {
    console.warn("Claude Code Bridge: could not restore activity log:", err.message);
    // Bad file? Wipe it so we don't keep failing every session.
    try { nova.fs.remove(activityStorePath()); } catch (_) {}
  }
}

function scheduleActivityPersist() {
  if (activityPersistTimer) return;
  activityPersistTimer = setTimeout(function() {
    activityPersistTimer = null;
    flushActivityLog();
  }, ACTIVITY_PERSIST_DEBOUNCE_MS);
}

function flushActivityLog() {
  if (activityPersistTimer) {
    clearTimeout(activityPersistTimer);
    activityPersistTimer = null;
  }
  try {
    var dir = nova.extension.globalStoragePath;
    try { nova.fs.mkdir(dir); } catch (_) {}
    var f = nova.fs.open(activityStorePath(), "w");
    f.write(JSON.stringify({
      version: 1,
      savedAt: Date.now(),
      activityLog: activityLog,
      toolCallLog: toolCallLog,
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
  var bodyLines = [
    diff.filePath,
    "Proposed: " + new Date(diff.openedAt).toLocaleString(),
  ];
  if (diff.stats) bodyLines.push("Change: " + formatStats(diff.stats));
  bodyLines.push("Proposal length: " + diff.newContent.length + " characters");
  bodyLines.push("Tab name: " + diff.tabName);
  req.body = bodyLines.join("\n");
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
  // Per-workspace extra args (e.g. "--continue", "--model claude-opus-4-7").
  // Trimmed and appended verbatim — the user is in charge of quoting if a
  // value contains spaces, just as if they typed the command themselves.
  var claudeArgs = (nova.workspace.config.get("claudecode.claudeArgs") || "").trim();
  var envPrefix = "CLAUDE_CODE_SSE_PORT=" + serverPort + " ENABLE_IDE_INTEGRATION=true";
  var fullCommand = "cd " + shellQuote(workspace) + " && " + envPrefix + " " + claudeCmd;
  if (claudeArgs) fullCommand += " " + claudeArgs;

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

// Quick existence check across the standard install locations on macOS.
// Terminal.app ships in /System/Applications/Utilities/ on modern macOS,
// not /Applications/ — missing that path was a long-standing bug that made
// the auto-detect fall through to clipboard mode on stock systems.
function isAppInstalled(name) {
  var candidates = [
    "/Applications/" + name + ".app",
    "/Applications/Utilities/" + name + ".app",
    "/System/Applications/" + name + ".app",
    "/System/Applications/Utilities/" + name + ".app",
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
