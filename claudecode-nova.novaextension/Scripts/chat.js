// chat.js — Chat (Mode B) helpers — API key resolution (Keychain / 1Password / config), access token, Open Chat command, Nova Preview wrapper.
//
// Split out of the former 3 500-line main.js (v0.28.0). Runs in Nova's
// JavaScriptCore runtime (CommonJS require, no Node built-ins). Nova's
// require() does NOT support circular dependencies (it recurses until
// "Maximum call stack size exceeded"), so modules never require each other:
// each one attaches its exports to the shared registry (R.<Name>) at the
// bottom, and cross-module calls dereference R.<Name>.fn at call time.

const S = require("./state.js");
const R = require("./registry.js");

// macOS Keychain entry coordinates. Defaults match this extension's own
// namespace, but both can be re-pointed at an existing entry from another
// app (Claude Desktop, Cline, etc.) via the `claudecode.chat.keychainService`
// and `claudecode.chat.keychainAccount` config keys. Read at call time so
// changing them in settings takes effect on the next operation.
const DEFAULT_KEYCHAIN_SERVICE = "ca.okapi.claudecode-nova";

const DEFAULT_KEYCHAIN_ACCOUNT = "anthropic-api-key";

function chatKeychainService() {
  return (nova.config.get("claudecode.chat.keychainService") || "").trim() || DEFAULT_KEYCHAIN_SERVICE;
}

function chatKeychainAccount() {
  return (nova.config.get("claudecode.chat.keychainAccount") || "").trim() || DEFAULT_KEYCHAIN_ACCOUNT;
}

// Resolve the Anthropic API key for chat mode. Priority order :
//   1. macOS Keychain (native, persistent)
//   2. 1Password CLI (op read — requires active `op signin` session)
//   3. Plain-text config value (last-resort fallback)
// Returns the key, or empty string if no source yields one.

// Determine which source resolveChatApiKey() would pick — used by the
// Chat UI Status sidebar so the user can see where the key came from
// without exposing the key itself. Order matches resolveChatApiKey.
async function detectChatApiKeySource() {
  const kc = await readChatKeyFromKeychain();
  if (kc) return "keychain";
  if ((nova.config.get("claudecode.chat.apiKey1PassRef") || "").trim()) return "1password";
  if ((nova.config.get("claudecode.chat.apiKey") || "").trim()) return "config";
  return null;
}

async function resolveChatApiKey() {
  // 1) Keychain — preferred (set via the "Set Claude Chat API Key" command)
  const kc = await readChatKeyFromKeychain();
  if (kc) return kc;

  // 2) 1Password CLI — only if a reference is configured
  const opRef = (nova.config.get("claudecode.chat.apiKey1PassRef") || "").trim();
  if (opRef) {
    try {
      const key = await runOpRead(opRef);
      if (key) return key;
    } catch (err) {
      console.warn("Claude Code Bridge: op read failed (" + err.message + ")");
    }
  }

  // 3) Direct config — last-resort plain-text fallback
  return (nova.config.get("claudecode.chat.apiKey") || "").trim();
}

// Read the API key from the macOS Keychain at the configured service +
// account. Empty string on miss/error — caller falls through to next source.
async function readChatKeyFromKeychain() {
  try {
    const key = await nova.credentials.getPassword(chatKeychainService(), chatKeychainAccount());
    return (key || "").trim();
  } catch (_) {
    return "";
  }
}

// "Set Claude Chat API Key" command — secure-input notification, stores
// the key in macOS Keychain at the configured service/account. The user
// must restart the bridge for the new key to take effect.
async function setChatApiKeyHandler() {
  const svc = chatKeychainService();
  const acct = chatKeychainAccount();

  const req = new NotificationRequest("claudecode.setChatApiKey");
  req.title = "Set Claude Chat API Key";
  req.body  =
    "Paste your Anthropic API key (starts with `sk-ant-…`).\n\n" +
    "Will be stored in macOS Keychain at :\n" +
    "  service : " + svc + "\n" +
    "  account : " + acct + "\n\n" +
    "Restart the bridge after saving for it to take effect.";
  req.type  = "secure-input";
  req.textInputPlaceholder = "sk-ant-...";
  req.actions = ["Save", "Cancel"];

  let reply;
  try {
    reply = await nova.notifications.add(req);
  } catch (err) {
    console.warn("Claude Code Bridge: setChatApiKey notification cancelled — " + err.message);
    return;
  }

  if (reply.actionIdx !== 0) return; // Cancel

  const key = (reply.textInputValue || "").trim();
  if (!key) {
    R.Util.showNotification("Empty key", "No API key entered — nothing stored.");
    return;
  }
  if (!key.startsWith("sk-ant-")) {
    R.Util.showNotification(
      "Suspicious format",
      "The key does not start with `sk-ant-`. Stored anyway — verify it's an Anthropic API key."
    );
  }

  try {
    await nova.credentials.setPassword(svc, acct, key);
    R.Util.showNotification(
      "Saved to Keychain",
      "API key stored at service `" + svc + "` / account `" + acct + "`.\nRestart the bridge for it to take effect."
    );
  } catch (err) {
    R.Util.showNotification("Save failed", "Could not store the key in Keychain: " + err.message);
  }
}

// "Clear Claude Chat API Key" command — removes the Keychain entry at the
// configured service/account. Warns explicitly so the user sees what's
// about to be deleted (especially relevant when pointing at an external app's entry).
async function clearChatApiKeyHandler() {
  const svc = chatKeychainService();
  const acct = chatKeychainAccount();

  try {
    await nova.credentials.removePassword(svc, acct);
    R.Util.showNotification(
      "Cleared",
      "Keychain entry removed (service `" + svc + "` / account `" + acct + "`).\nThe bridge will fall back to 1Password or direct config on next restart."
    );
  } catch (err) {
    R.Util.showNotification("Clear failed", err.message);
  }
}

// Run `op read <ref>` and capture stdout. Resolves with the trimmed output
// on exit 0, rejects on non-zero exit or spawn failure.
function runOpRead(ref) {
  return new Promise((resolve, reject) => {
    const proc = new Process("/usr/bin/env", {
      args: ["op", "read", ref],
      shell: false,
      stdio: "pipe",
    });
    let out = "";
    let err = "";
    proc.onStdout(function(chunk) { out += chunk; });
    proc.onStderr(function(chunk) { err += chunk; });
    proc.onDidExit(function(code) {
      if (code === 0) resolve(out.trim());
      else reject(new Error("op exit code " + code + ": " + err.trim()));
    });
    try {
      proc.start();
    } catch (spawnErr) {
      reject(new Error("Cannot spawn op CLI: " + spawnErr.message));
    }
  });
}

// "Open Claude Chat in Browser" command — surfaces the chat URL with
// three opening modes: copy to clipboard, open in default browser, or
// open inside Nova as a previewable HTML wrapper (which the user can
// then split-right via Cmd+Shift+H or drag-to-side).
// ---------------------------------------------------------------------------
// Chat access token
//
// The chat (/ws) and terminal (/cli) WebSockets are loopback-only, but a
// WebSocket opened from any web page is not subject to CORS — so without a
// secret, any site loaded in a browser on this Mac could reach the PTY.
// We mint one random token per install, persist it under the extension's
// global storage (mode 0600 by default) so the chat URL stays stable
// across bridge restarts, and pass it to ws-server.js as CC_CHAT_TOKEN.
// The token rides in the chat URL as ?token=…; chat.js forwards it on
// both WebSocket upgrades and ws-auth.mjs checks it in constant time.
// ---------------------------------------------------------------------------
function chatTokenPath() {
  return nova.path.join(nova.extension.globalStoragePath, "chat-token");
}

function randomToken() {
  try {
    if (nova.crypto && typeof nova.crypto.randomUUID === "function") {
      return nova.crypto.randomUUID();
    }
  } catch (_) {}
  // Fallback: 128 bits from Math.random — weaker, but only reachable on a
  // Nova build without nova.crypto, and still unguessable from a web page.
  var hex = "";
  for (var i = 0; i < 32; i++) hex += Math.floor(Math.random() * 16).toString(16);
  return hex;
}

function getOrCreateChatToken() {
  var tokenPath = chatTokenPath();
  try {
    var f = nova.fs.open(tokenPath, "r");
    var existing = (f.read() || "").trim();
    f.close();
    if (/^[A-Za-z0-9-]{32,}$/.test(existing)) return existing;
  } catch (_) { /* first run — fall through and create */ }

  var token = randomToken();
  try {
    try { nova.fs.mkdir(nova.extension.globalStoragePath); } catch (_) {}
    var out = nova.fs.open(tokenPath, "w");
    out.write(token);
    out.close();
  } catch (err) {
    // Not fatal: the token still protects this bridge run; it will just be
    // re-minted next time (and the wrapper file regenerated to match).
    console.warn("Claude Code Bridge: could not persist chat token: " + err.message);
  }
  return token;
}

// Regenerate the token (e.g. if the user suspects it leaked). Takes effect
// on the next bridge restart; existing chat tabs must be reopened.
function rotateChatToken() {
  try { nova.fs.remove(chatTokenPath()); } catch (_) {}
  S.chatState.token = getOrCreateChatToken();
  return S.chatState.token;
}

// Base URL (no token) — safe to show in notifications and the sidebar.
function chatBaseUrl(port) {
  return "http://127.0.0.1:" + (port || nova.config.get("claudecode.chat.port") || 5180) + "/";
}

// Full URL with the token — what we hand to the browser / Preview / clipboard.
function chatUrlWithToken(port) {
  var token = S.chatState.token || getOrCreateChatToken();
  return chatBaseUrl(port) + "?token=" + encodeURIComponent(token);
}

// Command: mint a new chat access token and restart the bridge so the
// chat / terminal servers pick it up. Open chat tabs must be reopened via
// "Open Claude Chat in Browser" (their URL carries the old token).
function rotateChatTokenHandler() {
  nova.workspace.showActionPanel(
    "Rotate the chat access token?\n\nThe bridge restarts and every open chat / terminal tab must be reopened from the \"Open Claude Chat in Browser\" command.",
    { buttons: ["Rotate and Restart", "Cancel"] },
    function(idx) {
      if (idx !== 0) return;
      rotateChatToken();
      R.Util.showNotification("Chat token rotated", "Restarting the bridge with the new token…");
      nova.commands.invoke("claudecode.restart");
    },
  );
}

function openChatHandler() {
  if (!nova.config.get("claudecode.chat.enabled")) {
    nova.workspace.showActionPanel(
      "Chat UI is currently disabled.",
      { buttons: ["Open Settings", "Cancel"] },
      function(idx) {
        if (idx === 0) nova.openConfig(nova.extension.identifier);
      },
    );
    return;
  }

  const port = nova.config.get("claudecode.chat.port") || 5180;
  const url  = chatUrlWithToken(port);

  nova.workspace.showActionPanel(
    "Claude Chat UI\n\n" + chatBaseUrl(port) + "\n\nThe copied / opened URL carries a private access token — don't paste it into shared places.\n\nOpen in Nova creates a previewable wrapper file you can split to the right; press Cmd+Shift+H to preview or right-click the tab → Split Right.",
    { buttons: ["Open in Nova Preview", "Open in Browser", "Copy URL", "Close"] },
    function(idx) {
      if (idx === 0) {
        openChatInNovaPreview(url);
      } else if (idx === 1) {
        try {
          const proc = new Process("/usr/bin/open", { args: [url], stdio: "ignore" });
          proc.start();
        } catch (err) {
          R.Util.showNotification("Cannot open browser", err.message);
        }
      } else if (idx === 2) {
        nova.clipboard.writeText(url);
        R.Util.showNotification("Copied", chatBaseUrl(port) + " (with access token) is in your clipboard.");
      }
    },
  );
}

// Write a tiny HTML wrapper that iframes the chat URL, then open it as
// a Nova editor tab. Nova's Preview tab (Cmd+Shift+H) renders this via
// WebKit, giving a chat panel inside Nova. Stored under the extension's
// global storage so it survives Nova restarts and doesn't pollute the
// workspace tree.
//
// We only (re)generate the file when it's missing OR when the configured
// chat URL no longer matches the URL embedded in the existing copy —
// otherwise the user is free to tweak styles / title / etc. and their
// edits are preserved across re-opens.
function openChatInNovaPreview(url) {
  const storage = nova.extension.globalStoragePath;
  try { nova.fs.mkdir(storage); } catch (_) {} // ignore EEXIST
  const wrapperPath = nova.path.join(storage, "chat-frame.html");

  if (!isChatWrapperFresh(wrapperPath, url)) {
    try {
      const file = nova.fs.open(wrapperPath, "w");
      file.write(buildChatWrapperHtml(url));
      file.close();
    } catch (err) {
      R.Util.showNotification("Cannot write chat wrapper", err.message);
      return;
    }
  }

  // If the wrapper is already open anywhere in Nova, the user
  // probably also has the WebKit Preview tab visible — calling
  // openFile() again would switch focus to the source-HTML tab and
  // hide the Preview the user actually cares about. Bail out silently
  // and let the WS broadcast reach the live chat client.
  const existing = (nova.workspace.textEditors || []).find(
    (ed) => ed.document && ed.document.path === wrapperPath
  );
  if (existing) return;

  nova.workspace.openFile(wrapperPath).then(function() {
    R.Util.showNotification(
      "Chat wrapper opened",
      "Press Cmd+Shift+H to show the Preview, then drag the Preview tab to the right to dock it. The chat is at " + chatBaseUrl() + "."
    );
  }, function(err) {
    R.Util.showNotification("Cannot open chat wrapper", err.message);
  });
}

function buildChatWrapperHtml(url) {
  return [
    "<!doctype html>",
    "<html lang=\"en\">",
    "<head>",
    "  <meta charset=\"utf-8\" />",
    "  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\" />",
    "  <title>Claude Chat</title>",
    "  <style>",
    "    html, body { margin: 0; padding: 0; height: 100%; background: #1e1e22; color-scheme: light dark; }",
    "    @media (prefers-color-scheme: light) {",
    "      html, body { background: #ffffff; }",
    "    }",
    "    iframe { width: 100%; height: 100%; border: 0; display: block; }",
    "  </style>",
    "</head>",
    "<body>",
    "  <iframe src=\"" + url + "\" allow=\"clipboard-read; clipboard-write\"></iframe>",
    "</body>",
    "</html>",
  ].join("\n");
}

// True if the wrapper file exists AND still references `url`. Lets the
// user customize the HTML freely without us overwriting their edits at
// every "Open in Nova Preview" click. Returns false when the file is
// missing, unreadable, or points at a different URL (port change etc.) —
// caller will rewrite from the template in those cases.
function isChatWrapperFresh(path, url) {
  let file;
  try { file = nova.fs.open(path, "r"); }
  catch (_) { return false; } // missing
  try {
    const content = file.read();
    return typeof content === "string" && content.indexOf("src=\"" + url + "\"") !== -1;
  } catch (_) {
    return false;
  } finally {
    try { file.close(); } catch (_) {}
  }
}

R.Chat = Object.assign(R.Chat || {}, {
  DEFAULT_KEYCHAIN_SERVICE,
  DEFAULT_KEYCHAIN_ACCOUNT,
  chatKeychainService,
  chatKeychainAccount,
  detectChatApiKeySource,
  resolveChatApiKey,
  readChatKeyFromKeychain,
  setChatApiKeyHandler,
  clearChatApiKeyHandler,
  runOpRead,
  chatTokenPath,
  randomToken,
  getOrCreateChatToken,
  rotateChatToken,
  chatBaseUrl,
  chatUrlWithToken,
  rotateChatTokenHandler,
  openChatHandler,
  openChatInNovaPreview,
  buildChatWrapperHtml,
  isChatWrapperFresh,
});
module.exports = R.Chat;
