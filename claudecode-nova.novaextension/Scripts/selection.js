// selection.js — Selection tracking + context commands (Send Selection / Add File → at_mention).
//
// Split out of the former 3 500-line main.js (v0.28.0). Runs in Nova's
// JavaScriptCore runtime (CommonJS require, no Node built-ins). Nova's
// require() does NOT support circular dependencies (it recurses until
// "Maximum call stack size exceeded"), so modules never require each other:
// each one attaches its exports to the shared registry (R.<Name>) at the
// bottom, and cross-module calls dereference R.<Name>.fn at call time.

const S = require("./state.js");
const R = require("./registry.js");

function startSelectionTracking() {
  var tracker = nova.workspace.onDidAddTextEditor(function(editor) {
    setupEditorTracking(editor);
  });
  S.disposables.push(tracker);

  var editors = nova.workspace.textEditors || [];
  for (var i = 0; i < editors.length; i++) {
    setupEditorTracking(editors[i]);
  }
}

function setupEditorTracking(editor) {
  var selDisposable = editor.onDidChangeSelection(function(changedEditor) {
    var selection = buildSelectionData(changedEditor);
    if (selection) {
      S.lastSelection = selection;
      R.Bridge.sendToServer({ type: "selection_update", data: selection });
    }
  });
  S.disposables.push(selDisposable);
}

function buildSelectionData(editor) {
  if (!editor || !editor.document) return null;

  var range = editor.selectedRange;
  var text = editor.selectedText || "";
  var doc = editor.document;
  var startPos = R.Tools.offsetToPosition(doc, range.start);
  var endPos = R.Tools.offsetToPosition(doc, range.end);

  return {
    filePath: doc.path || null,
    text: text,
    startLine: startPos.line,
    endLine: endPos.line,
    startColumn: startPos.column,
    endColumn: endPos.column,
    isEmpty: range.length === 0,
    syntax: doc.syntax || "plaintext",
    gitBranch: S.gitBranch,
  };
}

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
    R.Bridge.sendToServer({ type: "selection_update", data: selection });
    // Add the selection to Claude's context (the actual "@file:lines" mechanism)
    if (selection.filePath) {
      R.Bridge.sendToServer({
        type: "at_mention",
        data: {
          filePath: selection.filePath,
          lineStart: selection.startLine,
          lineEnd: selection.endLine,
        },
      });
    }
    R.Activity.logActivity("selection_sent", {
      filePath: selection.filePath,
      length: selection.text.length,
      startLine: selection.startLine,
      endLine: selection.endLine,
    });
    R.Sidebar.refreshActivitySidebar();
    R.Util.showNotification("Sent", "Selection sent to Claude Code context.");
  } else {
    R.Util.showNotification("No Selection", "Select some text first.");
  }
}

function addCurrentFile() {
  var editor = nova.workspace.activeTextEditor;
  if (!editor || !editor.document.path) {
    R.Util.showNotification("No File", "No file is currently open.");
    return;
  }

  var filePath = editor.document.path;

  // Send ONLY the @-mention (without lineStart/lineEnd → whole file). Sending
  // a selection_update alongside would confuse Claude, which would interpret
  // the (0,0) line range as "0 lines selected" and truncate the context.
  R.Bridge.sendToServer({
    type: "at_mention",
    data: {
      filePath: filePath,
    },
  });

  R.Activity.logActivity("file_added", { filePath: filePath, length: editor.document.length });
  R.Sidebar.refreshActivitySidebar();
  R.Util.showNotification("File Added", nova.path.basename(filePath) + " added to Claude context.");
}

R.Selection = Object.assign(R.Selection || {}, {
  startSelectionTracking,
  setupEditorTracking,
  buildSelectionData,
  sendSelectionToContext,
  addCurrentFile,
});
module.exports = R.Selection;
