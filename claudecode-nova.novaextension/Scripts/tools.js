// tools.js — MCP tool handlers — Claude Code / chat tool calls mapped onto Nova APIs (openFile, openDiff, git, search, fs, editor edits…).
//
// Split out of the former 3 500-line main.js (v0.28.0). Runs in Nova's
// JavaScriptCore runtime (CommonJS require, no Node built-ins). Nova's
// require() does NOT support circular dependencies (it recurses until
// "Maximum call stack size exceeded"), so modules never require each other:
// each one attaches its exports to the shared registry (R.<Name>) at the
// bottom, and cross-module calls dereference R.<Name>.fn at call time.

const S = require("./state.js");
const R = require("./registry.js");

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
        R.Activity.logToolCall(tool, args, { deferred: true });
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
      case "getGitDiff":
        result = await toolGetGitDiff(args);
        break;
      case "getGitLog":
        result = await toolGetGitLog(args);
        break;
      case "workspaceSearch":
        result = await toolWorkspaceSearch(args);
        break;
      case "applyEditAtSelection":
        result = await toolApplyEditAtSelection(args);
        break;
      case "runShellCommand":
        result = await toolRunShellCommand(args);
        break;
      case "writeFile":
        result = await toolWriteFile(args);
        break;
      case "fileExists":
        result = await toolFileExists(args);
        break;
      case "notify":
        result = await toolNotify(args);
        break;
      case "askUser":
        result = await toolAskUser(args);
        break;
      case "listDirectory":
        result = await toolListDirectory(args);
        break;
      case "insertAtCursor":
        result = await toolInsertAtCursor(args);
        break;
      case "replaceInFile":
        result = await toolReplaceInFile(args);
        break;
      case "clipboardWrite":
        result = await toolClipboardWrite(args);
        break;
      case "openNewTextDocument":
        result = await toolOpenNewTextDocument(args);
        break;
      case "getOpenDocuments":
        result = await toolGetOpenDocuments(args);
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
  R.Activity.logToolCall(tool, args, result);
  if (!result || !result.error) {
    if (tool === "openFile" && args.filePath) {
      R.Activity.logActivity("file_opened", { filePath: args.filePath });
    } else if (tool === "saveDocument" && args.filePath) {
      R.Activity.logActivity("file_saved", { filePath: args.filePath });
    }
  }
  R.Sidebar.refreshActivitySidebar();

  R.Bridge.sendToServer({ type: "tool_result", requestId: requestId, result: result });
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
      await R.Util.delay(100);
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
    var stats = R.Activity.computeDiffStats(oldPath, newContent);

    var diffId = "diff_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);
    S.pendingDiffs.unshift({
      id: diffId,
      filePath: filePath,
      tmpFile: tmpFile,
      newContent: newContent,
      tabName: tabName || "proposed",
      requestId: requestId,
      openedAt: Date.now(),
      stats: stats,
    });
    R.Activity.logActivity("diff_proposed", { filePath: filePath, diffId: diffId, stats: stats });
    R.Sidebar.refreshActivitySidebar();

    var notification = new NotificationRequest("claudecode-diff-" + diffId);
    notification.title = "Claude Code Diff";
    notification.body = "Review changes for " + nova.path.basename(filePath) + " (" + R.Activity.formatStats(stats) + ").\nProposed changes are open in a new tab (" + (tabName || "proposed") + ").";
    notification.actions = ["Accept Changes", "Reject"];

    nova.notifications.add(notification).then(function(response) {
      resolveDiff(diffId, response.actionIdx === 0);
    });

  } catch (err) {
    R.Bridge.sendToServer({
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
  var idx = S.pendingDiffs.findIndex(function(d) { return d.id === diffId; });
  if (idx === -1) return;
  var diff = S.pendingDiffs[idx];
  S.pendingDiffs.splice(idx, 1);

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

  R.Activity.logActivity(accepted ? "diff_accepted" : "diff_rejected", {
    filePath: diff.filePath,
    diffId: diffId,
    userEdited: userEdited,
  });
  R.Sidebar.refreshActivitySidebar();

  R.Bridge.sendToServer({
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
  if (S.lastSelection) return S.lastSelection;
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
    gitBranch: S.gitBranch,
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

// --- getGitDiff ---
//
// Run `git diff` (or `git diff --cached` for staged-only, or a range
// like `main..HEAD`) in the workspace root and return stdout. Used by
// the /commit /changelog /pr slash commands so Claude can write
// commit / changelog / PR copy grounded in actual changes.
//
// args:
//   staged?: boolean  → adds --cached
//   range?: string    → e.g. "main..HEAD" or "v0.14.1..HEAD"
//   stat?: boolean    → adds --stat (summary instead of full hunks)
//   maxBytes?: number → truncate the output (default 64 KB)
function toolGetGitDiff(args) {
  var workspace = nova.workspace.path;
  if (!workspace) {
    return Promise.resolve({ error: "No workspace open" });
  }
  var gitArgs = ["diff"];
  if (args && args.stat) gitArgs.push("--stat");
  if (args && args.staged) gitArgs.push("--cached");
  if (args && typeof args.range === "string" && args.range.trim()) {
    gitArgs.push(args.range.trim());
  }
  var maxBytes = (args && Number.isInteger(args.maxBytes)) ? args.maxBytes : 64 * 1024;

  return new Promise(function(resolve) {
    var proc;
    try {
      proc = new Process("/usr/bin/env", {
        args: ["git", "-C", workspace].concat(gitArgs),
        stdio: "pipe",
      });
    } catch (err) {
      resolve({ error: "git spawn failed: " + err.message });
      return;
    }
    var out = "";
    var err = "";
    proc.onStdout(function(chunk) { if (out.length < maxBytes) out += chunk; });
    proc.onStderr(function(chunk) { err += chunk; });
    proc.onDidExit(function(code) {
      if (code !== 0 && !out) {
        resolve({ error: "git exit " + code + ": " + err.trim() });
        return;
      }
      var truncated = out.length >= maxBytes;
      resolve({
        command: ["git"].concat(gitArgs).join(" "),
        cwd: workspace,
        diff: truncated ? out.slice(0, maxBytes) : out,
        truncated: truncated,
        empty: out.trim().length === 0,
      });
    });
    try { proc.start(); }
    catch (e) { resolve({ error: "git start failed: " + e.message }); }
  });
}

// --- workspaceSearch ---
//
// Recursive grep across the workspace. Used by /search (literal
// text) and /find (regex tuned for symbol definitions). Returns up
// to `maxHits` matches as `{file, line, text}` records.
//
// Backed by /usr/bin/grep (universally available) rather than ripgrep
// because Nova's subprocess doesn't see the user's shell PATH.
//
// args:
//   query: string         — text or regex to search for (required)
//   regex?: boolean       — true = -E (extended regex), false = -F (fixed string)
//   glob?: string         — file include pattern, e.g. "*.ts" or "*.{js,ts}"
//   maxHits?: number      — stop after N matches (default 200)
//   maxBytes?: number     — cap stdout (default 256 KB)
function toolWorkspaceSearch(args) {
  var workspace = nova.workspace.path;
  if (!workspace) return Promise.resolve({ error: "No workspace open" });
  if (!args || typeof args.query !== "string" || !args.query) {
    return Promise.resolve({ error: "query is required" });
  }
  var maxHits = (args && Number.isInteger(args.maxHits)) ? args.maxHits : 200;
  var maxBytes = (args && Number.isInteger(args.maxBytes)) ? args.maxBytes : 256 * 1024;

  // grep flags:
  //   -r recursive   -I skip binaries   -n show line numbers
  //   -H always print filename   --color=never (avoid ANSI escapes)
  //   --exclude-dir to skip the usual heavy directories
  var grepArgs = [
    "-rInH", "--color=never",
    "--exclude-dir=.git",
    "--exclude-dir=node_modules",
    "--exclude-dir=.next",
    "--exclude-dir=dist",
    "--exclude-dir=build",
    "--exclude-dir=.venv",
    "--exclude-dir=__pycache__",
    "-m", String(maxHits),
  ];
  if (args.glob && typeof args.glob === "string") {
    grepArgs.push("--include=" + args.glob);
  }
  grepArgs.push(args.regex ? "-E" : "-F");
  grepArgs.push("--", args.query, workspace);

  return new Promise(function(resolve) {
    var proc;
    try {
      proc = new Process("/usr/bin/grep", { args: grepArgs, stdio: "pipe" });
    } catch (err) {
      resolve({ error: "grep spawn failed: " + err.message });
      return;
    }
    var out = "";
    proc.onStdout(function(chunk) { if (out.length < maxBytes) out += chunk; });
    proc.onStderr(function() {});
    proc.onDidExit(function(code) {
      // grep exits 1 when no match — that's a normal "empty" result.
      // Exit 2+ means an actual error (bad regex, etc.).
      if (code > 1) { resolve({ error: "grep exit " + code }); return; }
      var hits = [];
      var lines = out.split("\n");
      for (var i = 0; i < lines.length && hits.length < maxHits; i++) {
        var line = lines[i];
        if (!line) continue;
        // Format: "<filepath>:<lineno>:<text>"
        var m = line.match(/^(.*?):(\d+):(.*)$/);
        if (!m) continue;
        hits.push({
          file: m[1].replace(workspace + "/", ""),
          line: parseInt(m[2], 10),
          text: m[3],
        });
      }
      resolve({
        command: ["grep"].concat(grepArgs).join(" "),
        cwd: workspace,
        hits: hits,
        truncated: out.length >= maxBytes || hits.length >= maxHits,
        empty: hits.length === 0,
      });
    });
    try { proc.start(); }
    catch (e) { resolve({ error: "grep start failed: " + e.message }); }
  });
}

// --- getGitLog ---
//
// Run `git log` in the workspace root and return the commit list.
// Used by /changelog and /pr to ground generated copy in actual
// commit history.
//
// args:
//   range?: string   → e.g. "v0.14.2..HEAD" or "main..feature/x"
//   limit?: number   → max commits returned (default 50)
//   format?: string  → "oneline" (sha + subject), "subject" (one
//                      subject per line), "full" (subject + body),
//                      defaults to "oneline"
//   maxBytes?: number → cap output size (default 64 KB)
function toolGetGitLog(args) {
  var workspace = nova.workspace.path;
  if (!workspace) {
    return Promise.resolve({ error: "No workspace open" });
  }
  var fmt = (args && args.format) || "oneline";
  var limit = (args && Number.isInteger(args.limit)) ? args.limit : 50;
  var maxBytes = (args && Number.isInteger(args.maxBytes)) ? args.maxBytes : 64 * 1024;
  var gitArgs = ["log", "--no-color", "-n", String(limit)];

  if (fmt === "oneline") {
    gitArgs.push("--pretty=format:%h %s");
  } else if (fmt === "subject") {
    gitArgs.push("--pretty=format:%s");
  } else if (fmt === "full") {
    gitArgs.push("--pretty=format:%h %s%n%n%b%n---");
  } else {
    return Promise.resolve({ error: "Unknown format: " + fmt });
  }
  if (args && typeof args.range === "string" && args.range.trim()) {
    gitArgs.push(args.range.trim());
  }

  return new Promise(function(resolve) {
    var proc;
    try {
      proc = new Process("/usr/bin/env", {
        args: ["git", "-C", workspace].concat(gitArgs),
        stdio: "pipe",
      });
    } catch (err) {
      resolve({ error: "git spawn failed: " + err.message });
      return;
    }
    var out = "";
    var err = "";
    proc.onStdout(function(chunk) { if (out.length < maxBytes) out += chunk; });
    proc.onStderr(function(chunk) { err += chunk; });
    proc.onDidExit(function(code) {
      if (code !== 0 && !out) {
        resolve({ error: "git exit " + code + ": " + err.trim() });
        return;
      }
      var truncated = out.length >= maxBytes;
      resolve({
        command: ["git"].concat(gitArgs).join(" "),
        cwd: workspace,
        log: truncated ? out.slice(0, maxBytes) : out,
        truncated: truncated,
        empty: out.trim().length === 0,
      });
    });
    try { proc.start(); }
    catch (e) { resolve({ error: "git start failed: " + e.message }); }
  });
}

// --- applyEditAtSelection ---
//
// Replace the current selection in the active TextEditor with new text.
// Used by chat slash commands like /refactor or /simplify when the model
// returns a self-contained replacement that doesn't need a diff review.
//
// args:
//   text: string             → required, the replacement
//   trimTrailingNewline?: boolean → strip a trailing \n from text (default true)
//
// Returns: { ok, file, line, replaced } or { error }
function toolApplyEditAtSelection(args) {
  if (!args || typeof args.text !== "string") {
    return Promise.resolve({ error: "text (string) is required" });
  }
  var editor = nova.workspace.activeTextEditor;
  if (!editor) return Promise.resolve({ error: "No active text editor" });
  var range = editor.selectedRange;
  if (!range) return Promise.resolve({ error: "No selection in active editor" });
  var trim = (args.trimTrailingNewline !== false);
  var newText = trim ? args.text.replace(/\n$/, "") : args.text;
  var beforeLen = range.length;

  return editor.edit(function(edit) {
    edit.replace(range, newText);
  }).then(function() {
    var doc = editor.document;
    return {
      ok: true,
      file: doc.path || doc.uri,
      range: { start: range.start, end: range.start + newText.length },
      replacedBytes: beforeLen,
      insertedBytes: newText.length,
    };
  }, function(err) {
    return { error: "edit failed: " + (err && err.message ? err.message : String(err)) };
  });
}

// --- runShellCommand ---
//
// Spawn /bin/sh -c <command> in the workspace (or args.cwd), capture
// stdout + stderr, enforce a timeout. Intentionally permissive: no
// safe-list. Marc gates access by deciding which prompts/skills can
// invoke it — the SDK already gates tool-use behind the chat UI.
//
// args:
//   command: string         → required, shell command line
//   cwd?: string            → override workspace path
//   timeoutMs?: number      → SIGTERM after N ms (default 30000)
//   maxBytes?: number       → cap captured output per stream (default 64 KB)
//
// Returns: { ok, code, signal, stdout, stderr, timedOut, truncated, durationMs }
function toolRunShellCommand(args) {
  if (!args || typeof args.command !== "string" || !args.command.trim()) {
    return Promise.resolve({ error: "command (string) is required" });
  }
  var cwd = (args.cwd && typeof args.cwd === "string") ? args.cwd : nova.workspace.path;
  if (!cwd) return Promise.resolve({ error: "No workspace open and no cwd provided" });
  var timeoutMs = (Number.isInteger(args.timeoutMs) && args.timeoutMs > 0) ? args.timeoutMs : 30000;
  var maxBytes = (Number.isInteger(args.maxBytes) && args.maxBytes > 0) ? args.maxBytes : 64 * 1024;

  return new Promise(function(resolve) {
    var proc;
    try {
      proc = new Process("/bin/sh", {
        args: ["-c", args.command],
        cwd: cwd,
        stdio: "pipe",
      });
    } catch (err) {
      resolve({ error: "shell spawn failed: " + err.message });
      return;
    }
    var out = "";
    var err = "";
    var outTrunc = false;
    var errTrunc = false;
    var startedAt = Date.now();
    var timedOut = false;

    proc.onStdout(function(chunk) {
      if (out.length + chunk.length <= maxBytes) out += chunk;
      else { out += chunk.slice(0, Math.max(0, maxBytes - out.length)); outTrunc = true; }
    });
    proc.onStderr(function(chunk) {
      if (err.length + chunk.length <= maxBytes) err += chunk;
      else { err += chunk.slice(0, Math.max(0, maxBytes - err.length)); errTrunc = true; }
    });

    var timer = setTimeout(function() {
      timedOut = true;
      try { proc.terminate(); } catch (e) {}
    }, timeoutMs);

    proc.onDidExit(function(code) {
      clearTimeout(timer);
      resolve({
        ok: !timedOut && code === 0,
        code: code,
        command: args.command,
        cwd: cwd,
        stdout: out,
        stderr: err,
        timedOut: timedOut,
        truncated: outTrunc || errTrunc,
        durationMs: Date.now() - startedAt,
      });
    });

    try { proc.start(); }
    catch (e) { clearTimeout(timer); resolve({ error: "shell start failed: " + e.message }); }
  });
}

// --- writeFile ---
//
// Create or overwrite a file. nova.fs.open accepts modes:
//   "w"  → truncate + write   (default — overwrites if exists)
//   "a"  → append
//   "wx" → fail if file already exists (safe-create)
//
// args:
//   path: string             → required, absolute or workspace-relative
//   content: string          → required, text content
//   mode?: "w" | "a" | "wx"  → default "w"
//   createDirs?: boolean     → mkdir -p the parent dir first (default false)
//
// Returns: { ok, path, bytes, mode } or { error }
function toolWriteFile(args) {
  if (!args || typeof args.path !== "string" || !args.path) {
    return Promise.resolve({ error: "path (string) is required" });
  }
  if (typeof args.content !== "string") {
    return Promise.resolve({ error: "content (string) is required" });
  }
  var mode = (args.mode === "a" || args.mode === "wx") ? args.mode : "w";
  var path = args.path;
  if (!nova.path.isAbsolute(path)) {
    if (!nova.workspace.path) {
      return Promise.resolve({ error: "Relative path requires an open workspace" });
    }
    path = nova.path.join(nova.workspace.path, path);
  }

  // Safe-create: bail if file exists.
  if (mode === "wx") {
    if (nova.fs.stat(path)) {
      return Promise.resolve({ error: "File already exists: " + path });
    }
    mode = "w";
  }

  // Optional parent-dir creation. Walks up the path and mkdirs each missing
  // segment. We only create one level at a time because nova.fs.mkdir doesn't
  // accept a recursive flag.
  if (args.createDirs) {
    var parent = nova.path.dirname(path);
    var toCreate = [];
    var cursor = parent;
    while (cursor && cursor !== "/" && !nova.fs.stat(cursor)) {
      toCreate.unshift(cursor);
      cursor = nova.path.dirname(cursor);
    }
    for (var i = 0; i < toCreate.length; i++) {
      try { nova.fs.mkdir(toCreate[i]); }
      catch (err) { return Promise.resolve({ error: "mkdir failed at " + toCreate[i] + ": " + err.message }); }
    }
  }

  try {
    var file = nova.fs.open(path, mode);
    file.write(args.content);
    file.close();
    return Promise.resolve({
      ok: true,
      path: path,
      bytes: args.content.length,
      mode: mode,
    });
  } catch (err) {
    return Promise.resolve({ error: "write failed: " + (err && err.message ? err.message : String(err)) });
  }
}

// --- fileExists ---
//
// Stat a path and report what's there. Returns { exists: false } cleanly
// when nothing matches — not an error.
//
// args:
//   path: string  → required, absolute or workspace-relative
//
// Returns: { exists, isFile, isDirectory, isSymlink, size, mtime, path } or { error }
function toolFileExists(args) {
  if (!args || typeof args.path !== "string" || !args.path) {
    return Promise.resolve({ error: "path (string) is required" });
  }
  var path = args.path;
  if (!nova.path.isAbsolute(path)) {
    if (!nova.workspace.path) {
      return Promise.resolve({ error: "Relative path requires an open workspace" });
    }
    path = nova.path.join(nova.workspace.path, path);
  }
  var st;
  try { st = nova.fs.stat(path); }
  catch (err) { return Promise.resolve({ error: "stat failed: " + err.message }); }
  if (!st) {
    return Promise.resolve({ exists: false, path: path });
  }
  return Promise.resolve({
    exists: true,
    path: path,
    isFile: !!st.isFile,
    isDirectory: !!st.isDirectory,
    isSymlink: !!st.isSymbolicLink,
    size: typeof st.size === "number" ? st.size : null,
    mtime: st.mtime ? st.mtime.toISOString() : null,
  });
}

// --- notify ---
//
// Push a non-blocking notification to the user. No actions = pure info
// banner. `type` is a hint (we prefix the title accordingly because Nova's
// NotificationRequest doesn't expose a severity field).
//
// args:
//   title: string                       → required
//   body?: string                       → optional body text
//   type?: "info" | "warning" | "error" → default "info"
//
// Returns: { ok, id }
function toolNotify(args) {
  if (!args || typeof args.title !== "string" || !args.title) {
    return Promise.resolve({ error: "title (string) is required" });
  }
  var type = (args.type === "warning" || args.type === "error") ? args.type : "info";
  var prefix = (type === "error") ? "⚠️  " : (type === "warning" ? "⚠️  " : "ℹ️  ");
  var id = "claude-notify-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
  try {
    var req = new NotificationRequest(id);
    req.title = prefix + args.title;
    if (typeof args.body === "string" && args.body) req.body = args.body;
    nova.notifications.add(req);
    return Promise.resolve({ ok: true, id: id, type: type });
  } catch (err) {
    return Promise.resolve({ error: "notify failed: " + err.message });
  }
}

// --- askUser ---
//
// Block until the user answers via a native Nova modal. Two flavors:
//   * options provided → showActionPanel (button choice)
//   * options absent   → showInputPalette (free text)
//
// args:
//   question: string      → required, prompt text
//   options?: string[]    → 2–4 button labels for action panel
//   placeholder?: string  → input palette placeholder (free-text mode only)
//   defaultValue?: string → pre-filled input (free-text mode only)
//
// Returns:
//   action-panel mode → { selectedIndex, selectedValue } or { cancelled: true }
//   free-text   mode → { text }                          or { cancelled: true }
function toolAskUser(args) {
  if (!args || typeof args.question !== "string" || !args.question) {
    return Promise.resolve({ error: "question (string) is required" });
  }
  return new Promise(function(resolve) {
    try {
      if (Array.isArray(args.options) && args.options.length >= 2) {
        nova.workspace.showActionPanel(
          args.question,
          { buttons: args.options.slice(0, 4) },
          function(idx) {
            if (typeof idx !== "number" || idx < 0) {
              resolve({ cancelled: true });
            } else {
              resolve({ selectedIndex: idx, selectedValue: args.options[idx] });
            }
          }
        );
      } else {
        nova.workspace.showInputPalette(
          args.question,
          {
            placeholder: args.placeholder || "",
            value: args.defaultValue || "",
          },
          function(value) {
            if (value == null) resolve({ cancelled: true });
            else resolve({ text: value });
          }
        );
      }
    } catch (err) {
      resolve({ error: "ask failed: " + err.message });
    }
  });
}

// --- listDirectory ---
//
// Walk a directory and return entries. Shallow by default; pass
// `recursive: true` to walk subdirs (capped at maxEntries to keep
// payloads manageable).
//
// args:
//   path: string             → required, absolute or workspace-relative
//   recursive?: boolean      → default false
//   maxEntries?: number      → default 500
//   includeHidden?: boolean  → include dot-files (default false)
//
// Returns: { entries: [{name, isFile, isDirectory, isSymlink, size}], path, truncated }
function toolListDirectory(args) {
  if (!args || typeof args.path !== "string" || !args.path) {
    return Promise.resolve({ error: "path (string) is required" });
  }
  var path = args.path;
  if (!nova.path.isAbsolute(path)) {
    if (!nova.workspace.path) {
      return Promise.resolve({ error: "Relative path requires an open workspace" });
    }
    path = nova.path.join(nova.workspace.path, path);
  }
  var st;
  try { st = nova.fs.stat(path); }
  catch (err) { return Promise.resolve({ error: "stat failed: " + err.message }); }
  if (!st) return Promise.resolve({ error: "Path does not exist: " + path });
  if (!st.isDirectory) return Promise.resolve({ error: "Not a directory: " + path });

  var maxEntries = (Number.isInteger(args.maxEntries) && args.maxEntries > 0) ? args.maxEntries : 500;
  var recursive = !!args.recursive;
  var includeHidden = !!args.includeHidden;
  var SKIP_DIRS = { ".git": 1, "node_modules": 1, "dist": 1, "build": 1, ".next": 1, ".venv": 1, "__pycache__": 1 };
  var entries = [];
  var truncated = false;

  function walk(dir, relPrefix) {
    if (truncated) return;
    var names;
    try { names = nova.fs.listdir(dir); }
    catch (err) { return; }
    for (var i = 0; i < names.length; i++) {
      if (truncated) return;
      var name = names[i];
      if (!includeHidden && name.charAt(0) === ".") continue;
      var full = nova.path.join(dir, name);
      var s;
      try { s = nova.fs.stat(full); } catch (e) { continue; }
      if (!s) continue;
      var displayName = relPrefix ? (relPrefix + "/" + name) : name;
      entries.push({
        name: displayName,
        isFile: !!s.isFile,
        isDirectory: !!s.isDirectory,
        isSymlink: !!s.isSymbolicLink,
        size: typeof s.size === "number" ? s.size : null,
      });
      if (entries.length >= maxEntries) { truncated = true; return; }
      if (recursive && s.isDirectory && !SKIP_DIRS[name]) {
        walk(full, displayName);
      }
    }
  }
  walk(path, "");
  return Promise.resolve({ path: path, entries: entries, truncated: truncated });
}

// --- insertAtCursor ---
//
// Insert text at the active editor's cursor without replacing the
// selection. If there *is* a selection, text is inserted at the start
// of the selection (selection itself is unchanged). For replace-on-
// selection semantics use applyEditAtSelection.
//
// args:
//   text: string  → required
//
// Returns: { ok, file, offset, range: {start, end} } or { error }
function toolInsertAtCursor(args) {
  if (!args || typeof args.text !== "string") {
    return Promise.resolve({ error: "text (string) is required" });
  }
  var editor = nova.workspace.activeTextEditor;
  if (!editor) return Promise.resolve({ error: "No active text editor" });
  var range = editor.selectedRange;
  var offset = range ? range.start : 0;

  return editor.edit(function(edit) {
    edit.insert(offset, args.text);
  }).then(function() {
    var doc = editor.document;
    return {
      ok: true,
      file: doc.path || doc.uri,
      offset: offset,
      range: { start: offset, end: offset + args.text.length },
    };
  }, function(err) {
    return { error: "insert failed: " + (err && err.message ? err.message : String(err)) };
  });
}

// --- replaceInFile ---
//
// Find/replace inside a specific file's content. Reads the file via
// nova.fs.open(r), substitutes, writes back via nova.fs.open(w). Does
// NOT touch the editor — operates on disk. If the file is currently
// open in an editor, Nova may prompt to reload (standard external-edit
// behaviour).
//
// args:
//   path: string         → required
//   find: string         → required, literal text (or regex if regex=true)
//   replace: string      → required, replacement
//   regex?: boolean      → treat find as JS RegExp (default false)
//   flags?: string       → regex flags, default "g" when regex=true
//   maxReplacements?: number → cap to N substitutions (default unlimited)
//
// Returns: { ok, path, replacements, bytesBefore, bytesAfter } or { error }
function toolReplaceInFile(args) {
  if (!args || typeof args.path !== "string" || !args.path) {
    return Promise.resolve({ error: "path (string) is required" });
  }
  if (typeof args.find !== "string" || !args.find) {
    return Promise.resolve({ error: "find (non-empty string) is required" });
  }
  if (typeof args.replace !== "string") {
    return Promise.resolve({ error: "replace (string) is required" });
  }
  var path = args.path;
  if (!nova.path.isAbsolute(path)) {
    if (!nova.workspace.path) {
      return Promise.resolve({ error: "Relative path requires an open workspace" });
    }
    path = nova.path.join(nova.workspace.path, path);
  }
  var st;
  try { st = nova.fs.stat(path); }
  catch (err) { return Promise.resolve({ error: "stat failed: " + err.message }); }
  if (!st || !st.isFile) return Promise.resolve({ error: "Not a file: " + path });

  var content;
  try {
    var fr = nova.fs.open(path, "r");
    content = fr.read() || "";
    fr.close();
  } catch (err) {
    return Promise.resolve({ error: "read failed: " + err.message });
  }
  var before = content.length;
  var replacements = 0;
  var cap = (Number.isInteger(args.maxReplacements) && args.maxReplacements > 0) ? args.maxReplacements : Infinity;
  var next;

  if (args.regex) {
    var flags = (typeof args.flags === "string" && args.flags) ? args.flags : "g";
    if (flags.indexOf("g") === -1) flags += "g";
    var re;
    try { re = new RegExp(args.find, flags); }
    catch (err) { return Promise.resolve({ error: "invalid regex: " + err.message }); }
    next = content.replace(re, function(match) {
      if (replacements >= cap) return match;
      replacements++;
      // RegExp.replace doesn't pass `replace` here — we used the literal
      // `args.replace` already evaluated against `match` via the standard
      // $-substitution rules below.
      return args.replace.replace(/\$&/g, match);
    });
  } else {
    // Literal find — split + join for an O(n) full-replace.
    var parts = content.split(args.find);
    if (parts.length === 1) {
      next = content;
    } else if (cap === Infinity) {
      next = parts.join(args.replace);
      replacements = parts.length - 1;
    } else {
      var head = parts.slice(0, cap + 1).join(args.replace);
      var tail = parts.slice(cap + 1).join(args.find);
      next = head + (tail ? args.find + tail : "");
      replacements = cap;
    }
  }

  if (replacements === 0) {
    return Promise.resolve({
      ok: true, path: path, replacements: 0,
      bytesBefore: before, bytesAfter: before, unchanged: true,
    });
  }

  try {
    var fw = nova.fs.open(path, "w");
    fw.write(next);
    fw.close();
  } catch (err) {
    return Promise.resolve({ error: "write failed: " + err.message });
  }
  return Promise.resolve({
    ok: true, path: path,
    replacements: replacements,
    bytesBefore: before, bytesAfter: next.length,
  });
}

// --- clipboardWrite ---
//
// Put text on the macOS clipboard. Useful when Claude generates
// something the user will paste elsewhere (snippet for a wiki, a
// command to run in a different terminal, etc.).
//
// args:
//   text: string  → required
//
// Returns: { ok, bytes } or { error }
function toolClipboardWrite(args) {
  if (!args || typeof args.text !== "string") {
    return Promise.resolve({ error: "text (string) is required" });
  }
  return nova.clipboard.writeText(args.text).then(function() {
    return { ok: true, bytes: args.text.length };
  }, function(err) {
    return { error: "clipboard write failed: " + (err && err.message ? err.message : String(err)) };
  });
}

// --- openNewTextDocument ---
//
// Open a new unsaved document with optional initial content + syntax
// hint. Useful for scratch drafts (a spec being authored, a command
// list being assembled) before deciding whether/where to save.
//
// args:
//   content?: string  → initial document body
//   syntax?: string   → Nova syntax identifier (e.g. "markdown", "typescript")
//
// Returns: { ok, isUntitled, syntax? } or { error }
function toolOpenNewTextDocument(args) {
  var opts = {};
  if (args && typeof args.content === "string") opts.content = args.content;
  if (args && typeof args.syntax === "string" && args.syntax) opts.syntax = args.syntax;
  try {
    nova.workspace.openNewTextDocument(opts);
    return Promise.resolve({ ok: true, isUntitled: true, syntax: opts.syntax || null });
  } catch (err) {
    return Promise.resolve({ error: "openNewTextDocument failed: " + err.message });
  }
}

// --- getOpenDocuments ---
//
// Returns every TextDocument Nova has open (including background ones
// with no active editor). Different from getOpenEditors, which only
// returns currently-visible editor instances. Useful when Claude needs
// to know what files are loaded even if not focused.
//
// Returns: { documents: [{ path, uri, isDirty, isUntitled, isClosed, syntax, length, eol }] }
function toolGetOpenDocuments() {
  var docs = nova.workspace.textDocuments || [];
  var out = [];
  for (var i = 0; i < docs.length; i++) {
    var d = docs[i];
    out.push({
      path: d.path || null,
      uri: d.uri || null,
      isDirty: !!d.isDirty,
      isUntitled: !!d.isUntitled,
      isClosed: !!d.isClosed,
      syntax: d.syntax || null,
      length: typeof d.length === "number" ? d.length : null,
      eol: d.eol || null,
    });
  }
  return Promise.resolve({ documents: out });
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
  var snapshot = S.pendingDiffs.slice();
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

R.Tools = Object.assign(R.Tools || {}, {
  handleToolCall,
  toolOpenFile,
  toolOpenDiff,
  resolveDiff,
  offsetToPosition,
  toolGetCurrentSelection,
  toolGetLatestSelection,
  toolGetOpenEditors,
  toolGetWorkspaceFolders,
  toolCheckDocumentDirty,
  toolSaveDocument,
  toolGetDiagnostics,
  toolCloseTab,
  toolExecuteCode,
  toolGetGitDiff,
  toolWorkspaceSearch,
  toolGetGitLog,
  toolApplyEditAtSelection,
  toolRunShellCommand,
  toolWriteFile,
  toolFileExists,
  toolNotify,
  toolAskUser,
  toolListDirectory,
  toolInsertAtCursor,
  toolReplaceInFile,
  toolClipboardWrite,
  toolOpenNewTextDocument,
  toolGetOpenDocuments,
  toolCloseAllDiffTabs,
});
module.exports = R.Tools;
