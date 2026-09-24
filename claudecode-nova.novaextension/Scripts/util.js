// util.js — Small shared helpers (notifications, sleep, …).
//
// Split out of the former 3 500-line main.js (v0.28.0). Runs in Nova's
// JavaScriptCore runtime (CommonJS require, no Node built-ins). Nova's
// require() does NOT support circular dependencies (it recurses until
// "Maximum call stack size exceeded"), so modules never require each other:
// each one attaches its exports to the shared registry (R.<Name>) at the
// bottom, and cross-module calls dereference R.<Name>.fn at call time.

const R = require("./registry.js");

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

R.Util = Object.assign(R.Util || {}, {
  showNotification,
  delay,
  shellQuote,
  applescriptStringLiteral,
});
module.exports = R.Util;
