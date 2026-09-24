// launch.js — Launch Claude Code in an external terminal (iTerm / Terminal.app / clipboard) with the IDE-bridge env vars.
//
// Split out of the former 3 500-line main.js (v0.28.0). Runs in Nova's
// JavaScriptCore runtime (CommonJS require, no Node built-ins). Nova's
// require() does NOT support circular dependencies (it recurses until
// "Maximum call stack size exceeded"), so modules never require each other:
// each one attaches its exports to the shared registry (R.<Name>) at the
// bottom, and cross-module calls dereference R.<Name>.fn at call time.

const S = require("./state.js");
const R = require("./registry.js");

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
  if (!S.serverPort) {
    R.Util.showNotification("Not Ready", "Start the bridge first. The WebSocket server is not running.");
    return;
  }

  var workspace = nova.workspace.path || nova.environment["HOME"];
  var claudeCmd = nova.workspace.config.get("claudecode.claudeCommand") || "claude";
  // Per-workspace extra args (e.g. "--continue", "--model claude-opus-4-7").
  // Trimmed and appended verbatim — the user is in charge of quoting if a
  // value contains spaces, just as if they typed the command themselves.
  var claudeArgs = (nova.workspace.config.get("claudecode.claudeArgs") || "").trim();
  var envPrefix = "CLAUDE_CODE_SSE_PORT=" + S.serverPort + " ENABLE_IDE_INTEGRATION=true";
  var fullCommand = "cd " + R.Util.shellQuote(workspace) + " && " + envPrefix + " " + claudeCmd;
  if (claudeArgs) fullCommand += " " + claudeArgs;

  var app = resolveTerminalApp();

  if (app === "clipboard") {
    nova.clipboard.writeText(fullCommand);
    R.Util.showNotification("Copied", "Launch command copied to clipboard. Paste it in your terminal.");
    return;
  }

  if (!isAppInstalled(app)) {
    nova.clipboard.writeText(fullCommand);
    R.Util.showNotification(
      "Terminal Not Found",
      app + ".app is not installed. Command copied to clipboard instead — pick another terminal in extension settings."
    );
    return;
  }

  var script = buildTerminalScript(app, fullCommand);
  try {
    await runAppleScript(script);
    R.Util.showNotification("Launching", "Claude Code is starting in " + app + ". The IDE bridge will connect automatically.");
  } catch (err) {
    console.error("Claude Code Bridge: terminal launch failed:", err.message);
    nova.clipboard.writeText(fullCommand);
    R.Util.showNotification(
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
  var commandAS = R.Util.applescriptStringLiteral(fullCommand);
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

R.Launch = Object.assign(R.Launch || {}, {
  launchClaude,
  resolveTerminalApp,
  isAppInstalled,
  buildTerminalScript,
  runAppleScript,
});
module.exports = R.Launch;
