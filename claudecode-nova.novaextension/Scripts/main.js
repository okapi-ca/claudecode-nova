/**
 * Claude Code Bridge for Nova
 *
 * Main extension entry point. This file:
 *   1. Spawns the Node.js WebSocket server helper (ws-server.js)
 *   2. Communicates with it via JSON lines over stdin/stdout
 *   3. Maps MCP tool calls to Nova editor APIs
 *   4. Tracks editor selection and broadcasts changes
 *   5. Provides sidebar UI and commands
 *   6. Checks the Claude Code CLI for updates (manual + 24h auto)
 */

const UpdateCheck = require("./update-check.js");
const { VersionTreeProvider } = require("./version-tree-provider.js");
const { SessionsTreeProvider, sessionDirForWorkspace } = require("./sessions-tree-provider.js");
const { ChatStatusTreeProvider } = require("./chat-status-tree-provider.js");

const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24h auto-check throttle

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

// Claude Code CLI version state. Mutated by checkForUpdates() and read by
// the sidebar provider — same object reference passed both ways so the
// provider always reflects the latest snapshot after a reload().
let versionState = {
  state: "unknown",
  currentVersion: null,
  latestVersion: null,
  channel: "stable",
  lastCheckedAt: null,
  message: null,
};
let versionProvider = null;
let versionTree = null;
let updateInProgress = false;

// Chat UI (Mode B) lifecycle state. Mutated by startBridge() and the
// chat_started / chat_failed messages from ws-server.js. The same object
// is shared with ChatStatusTreeProvider.
let chatState = {
  state: "disabled",         // disabled | no_key | starting | running | failed | stopped
  port: null,
  model: null,
  apiKeySource: null,        // "keychain" | "1password" | "config"
  lastError: null,
  url: null,
  lastUpdatedAt: null,
};
let chatStatusProvider = null;
let chatStatusTree = null;

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
      nova.commands.register("claudecode.sessionsRefresh", sessionsRefreshHandler),
      nova.commands.register("claudecode.resumeSession", resumeSessionHandler),
      nova.commands.register("claudecode.checkForUpdates", function() { checkForUpdates(false); }),
      nova.commands.register("claudecode.openChat", openChatHandler),
      nova.commands.register("claudecode.setChatApiKey", setChatApiKeyHandler),
      nova.commands.register("claudecode.clearChatApiKey", clearChatApiKeyHandler),
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
    // Chat key resolution may need an `op read` round-trip, so startBridge is
    // now async. Fire-and-forget — no caller awaits the return.
    startBridge().catch((err) => {
      console.error("Claude Code Bridge: startBridge() failed:", err.message, err.stack || "");
      showNotification("Error", `Failed to start bridge: ${err.message}`);
    });
  }

  // Fire-and-forget: never block activate() on a network round-trip.
  maybeAutoCheckUpdates();

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
// Chat (Mode B) — opt-in chat UI helpers
// ---------------------------------------------------------------------------

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
    showNotification("Empty key", "No API key entered — nothing stored.");
    return;
  }
  if (!key.startsWith("sk-ant-")) {
    showNotification(
      "Suspicious format",
      "The key does not start with `sk-ant-`. Stored anyway — verify it's an Anthropic API key."
    );
  }

  try {
    await nova.credentials.setPassword(svc, acct, key);
    showNotification(
      "Saved to Keychain",
      "API key stored at service `" + svc + "` / account `" + acct + "`.\nRestart the bridge for it to take effect."
    );
  } catch (err) {
    showNotification("Save failed", "Could not store the key in Keychain: " + err.message);
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
    showNotification(
      "Cleared",
      "Keychain entry removed (service `" + svc + "` / account `" + acct + "`).\nThe bridge will fall back to 1Password or direct config on next restart."
    );
  } catch (err) {
    showNotification("Clear failed", err.message);
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
  const url  = "http://127.0.0.1:" + port + "/";

  nova.workspace.showActionPanel(
    "Claude Chat UI\n\n" + url + "\n\nOpen in Nova creates a previewable wrapper file you can split to the right; press Cmd+Shift+H to preview or right-click the tab → Split Right.",
    { buttons: ["Open in Nova Preview", "Open in Browser", "Copy URL", "Close"] },
    function(idx) {
      if (idx === 0) {
        openChatInNovaPreview(url);
      } else if (idx === 1) {
        try {
          const proc = new Process("/usr/bin/open", { args: [url], stdio: "ignore" });
          proc.start();
        } catch (err) {
          showNotification("Cannot open browser", err.message);
        }
      } else if (idx === 2) {
        nova.clipboard.writeText(url);
        showNotification("Copied", url + " is in your clipboard.");
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
      showNotification("Cannot write chat wrapper", err.message);
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
    showNotification(
      "Chat wrapper opened",
      "Press Cmd+Shift+H to show the Preview, then drag the Preview tab to the right to dock it. The chat is at " + url + "."
    );
  }, function(err) {
    showNotification("Cannot open chat wrapper", err.message);
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

// ---------------------------------------------------------------------------
// Bridge lifecycle
// ---------------------------------------------------------------------------

async function startBridge() {
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

  // Build env. If chat (Mode B) is opt-in, resolve the API key first
  // (1Password reference or direct config value) and add the CC_CHAT_* vars
  // so ws-server.js lazy-loads chat-session.mjs at startup.
  const env = {
    CC_PORT_MIN: String(portMin),
    CC_PORT_MAX: String(portMax),
    CC_WORKSPACE: workspace,
  };

  if (nova.config.get("claudecode.chat.enabled")) {
    try {
      const apiKey = await resolveChatApiKey();
      env.CC_CHAT_ENABLED = "1";
      env.CC_CHAT_PORT    = String(nova.config.get("claudecode.chat.port") || 5180);
      env.CC_CHAT_MODEL   = nova.config.get("claudecode.chat.model") || "claude-sonnet-4-6";
      // Pass the claude CLI path so chat-session.mjs can spawn it directly
      // when running in fallback "cli" mode (no API key resolved), and
      // so cli-session.mjs (embedded terminal panel) can launch the same
      // binary with the same user-configured args.
      env.CC_CLAUDE_PATH = nova.workspace.config.get("claudecode.claudeCommand") || "claude";
      env.CC_CLAUDE_ARGS = nova.workspace.config.get("claudecode.claudeArgs") || "";
      env.CC_CHAT_THEME  = nova.config.get("claudecode.chat.theme") || "auto";
      env.CC_CHAT_CLI_PERMISSION_MODE = nova.config.get("claudecode.chat.cliPermissionMode") || "acceptEdits";

      if (apiKey) {
        env.ANTHROPIC_API_KEY = apiKey;
        console.log("Claude Code Bridge: chat enabled (SDK mode), port " + env.CC_CHAT_PORT + ", model " + env.CC_CHAT_MODEL);
        chatState.apiKeySource = await detectChatApiKeySource();
      } else {
        console.log("Claude Code Bridge: chat enabled (CLI fallback — no API key), port " + env.CC_CHAT_PORT + ", model " + env.CC_CHAT_MODEL);
        chatState.apiKeySource = "claude-cli";
      }

      chatState.state = "starting";
      chatState.port = parseInt(env.CC_CHAT_PORT, 10) || 5180;
      chatState.model = env.CC_CHAT_MODEL;
      chatState.lastError = null;
      chatState.url = "http://127.0.0.1:" + chatState.port + "/";
      refreshChatStatusSidebar();
    } catch (err) {
      console.error("Claude Code Bridge: chat API key resolution failed:", err.message);
      chatState.state = "failed";
      chatState.lastError = err.message;
      refreshChatStatusSidebar();
    }
  } else {
    chatState.state = "disabled";
    refreshChatStatusSidebar();
  }

  try {
    serverProcess = new Process(nodePath, {
      args: [scriptPath],
      env,
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
    // Chat lives inside the ws-server subprocess — if the subprocess died,
    // chat is gone too. Only downgrade to "stopped" if we hadn't already
    // recorded a more specific failure (chat_failed sets "failed").
    if (chatState.state !== "disabled" && chatState.state !== "failed") {
      chatState.state = "stopped";
      refreshChatStatusSidebar();
    }
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

    case "chat_started":
      console.log("Claude Code Bridge: chat server started on port " + msg.port);
      chatState.state = "running";
      chatState.port = msg.port || chatState.port;
      chatState.url = "http://127.0.0.1:" + chatState.port + "/";
      chatState.lastError = null;
      refreshChatStatusSidebar();
      showNotification(
        "Chat UI ready",
        "Claude chat is live at " + chatState.url + "\nUse \"Open Claude Chat in Browser\" command to open it, or configure Nova Project Settings → Preview URL."
      );
      break;

    case "chat_failed":
      console.error("Claude Code Bridge: chat server failed — " + msg.message);
      chatState.state = "failed";
      chatState.lastError = msg.message || "unknown error";
      refreshChatStatusSidebar();
      showNotification("Chat UI failed to start", msg.message);
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
      // Show diff size inline so the user can triage at-a-glance — a
      // 1-line tweak looks very different from an 80-line rewrite. Falls
      // back to just time when stats aren't computed yet.
      item.descriptiveText = d.stats
        ? formatStats(d.stats) + "  ·  " + relativeTime(d.openedAt)
        : relativeTime(d.openedAt);
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
var sessionsProvider = null;
var sessionsTree = null;
var sessionsWatcher = null;

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
    if (!versionProvider) {
      versionProvider = new VersionTreeProvider(versionState);
      versionTree = new TreeView("claudecode.sidebar.version", {
        dataProvider: versionProvider,
      });
      disposables.push(versionTree);
    }
    if (!sessionsProvider) {
      sessionsProvider = new SessionsTreeProvider();
      try { sessionsProvider.refresh(); }
      catch (e) { console.warn("Claude Code Bridge: initial sessions scan failed:", e.message); }
      sessionsTree = new TreeView("claudecode.sidebar.sessions", {
        dataProvider: sessionsProvider,
      });
      disposables.push(sessionsTree);
      startSessionsWatcher();
    }
    if (!chatStatusProvider) {
      // Hydrate from config so the row reflects intent immediately, even
      // before startBridge() has a chance to mutate the state.
      if (nova.config.get("claudecode.chat.enabled") !== true) {
        chatState.state = "disabled";
      }
      chatStatusProvider = new ChatStatusTreeProvider(chatState);
      chatStatusTree = new TreeView("claudecode.sidebar.chat", {
        dataProvider: chatStatusProvider,
      });
      disposables.push(chatStatusTree);
    }
  } catch (err) {
    console.error("Claude Code Bridge: activity sidebar init failed:", err.message);
  }
}

function refreshChatStatusSidebar() {
  ensureActivitySidebars();
  chatState.lastUpdatedAt = Date.now();
  try { if (chatStatusTree) chatStatusTree.reload(); } catch (_) {}
}

// Watch the per-workspace session directory so the sidebar updates when
// Claude Code creates a new session or appends to an existing one. fs.watch
// is debounced via a short timer because a single Claude turn appends many
// JSONL events in quick succession.
var sessionsRefreshTimer = null;
function startSessionsWatcher() {
  if (sessionsWatcher) return;
  var dir = sessionDirForWorkspace();
  if (!dir) return;
  try {
    sessionsWatcher = nova.fs.watch(dir + "/*.jsonl", function() {
      if (sessionsRefreshTimer) return;
      sessionsRefreshTimer = setTimeout(function() {
        sessionsRefreshTimer = null;
        refreshSessionsSidebar();
      }, 500);
    });
    disposables.push(sessionsWatcher);
  } catch (err) {
    console.warn("Claude Code Bridge: sessions watcher failed:", err.message);
  }
}

function refreshSessionsSidebar() {
  if (!sessionsProvider || !sessionsTree) return;
  try {
    sessionsProvider.refresh();
    sessionsTree.reload();
  } catch (err) {
    console.error("Claude Code Bridge: sessions refresh failed:", err.message);
  }
}

function refreshVersionSidebar() {
  ensureActivitySidebars();
  try { if (versionTree) versionTree.reload(); } catch (_) {}
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
  if (!sessionsTree) return;
  var sel = sessionsTree.selection;
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
          showNotification("Copied", resumeCmd);
        } catch (err) {
          showNotification("Copy failed", err.message);
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
    showNotification("Chat disabled", "Enable Chat UI in extension settings to resume there.");
    return;
  }
  sendToServer({ type: "resume_in_chat", sessionId: sessionId });
  showNotification(
    "Resume sent to chat",
    "If the chat window isn't open, run \"Open Claude Chat in Browser\" first, then click Resume again."
  );
}

// Resume inside the embedded xterm.js terminal panel. ws-server
// reconnects the /cli WS spawning `claude --resume <id>` this time.
// Same rationale as resumeSessionInChat: we don't reopen the wrapper.
function resumeSessionInCliPanel(sessionId) {
  if (!nova.config.get("claudecode.chat.enabled")) {
    showNotification("Chat disabled", "Enable Chat UI in extension settings to resume in the embedded CLI panel.");
    return;
  }
  sendToServer({ type: "resume_in_cli", sessionId: sessionId });
  showNotification(
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
    showNotification("Copied", command);
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
    showNotification("Resumed in Terminal", "Session " + sessionId.slice(0, 8) + "… opened.");
  } catch (err) {
    nova.clipboard.writeText(command);
    showNotification("Copied (osascript failed)", command);
  }
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
// Claude Code CLI version check & update
// ---------------------------------------------------------------------------
//
// Three entry points feed the same pipeline:
//   1. activate() → maybeAutoCheckUpdates() — silent, throttled to 24h.
//   2. Command "Claude Code: Check for Updates" → checkForUpdates(false).
//   3. Sidebar click on the version row → checkForUpdates(false).
//
// `silent=true` suppresses all notifications EXCEPT the "update available"
// one — that's the whole point of the daily auto-check.

function maybeAutoCheckUpdates() {
  // Hydrate the sidebar from the cached version BEFORE deciding to hit npm.
  // Without this, when the 24h throttle blocks the network call, versionState
  // stays at "unknown" and the sidebar shows "version unknown" until the next
  // manual check — even though we already know the version from disk.
  const lastSeen = nova.config.get("claudecode.updateCheck.lastSeenVersion");
  const lastCheckedAt = nova.config.get("claudecode.updateCheck.lastCheckedAt") || null;
  if (lastSeen) {
    versionState.state = "installed";
    versionState.currentVersion = lastSeen;
    versionState.lastCheckedAt = lastCheckedAt;
    refreshVersionSidebar();
  }

  if (nova.config.get("claudecode.updateCheck.autoCheck") === false) return;
  if (lastCheckedAt && Date.now() - lastCheckedAt < UPDATE_CHECK_INTERVAL_MS) return;
  checkForUpdates(true).catch(function(err) {
    console.warn("Claude Code Bridge: auto-check failed:", err.message);
  });
}

async function checkForUpdates(silent) {
  const claudeCommand = nova.workspace.config.get("claudecode.claudeCommand") || "claude";
  const channel = nova.config.get("claudecode.updateCheck.channel") || "stable";
  versionState.channel = channel;

  if (!silent) {
    versionState.state = "checking";
    versionState.message = null;
    refreshVersionSidebar();
  }

  let current;
  try {
    current = await UpdateCheck.getCurrentVersion(claudeCommand);
  } catch (err) {
    console.error("Claude Code Bridge: getCurrentVersion failed:", err.message);
    versionState.state = "error";
    versionState.message = err.message;
    refreshVersionSidebar();
    if (!silent) showNotification("Update Check Failed", err.message);
    persistLastChecked();
    return;
  }

  if (current.state === "not_installed") {
    versionState.state = "not_installed";
    versionState.currentVersion = null;
    versionState.message = "Claude Code CLI was not found on PATH.";
    refreshVersionSidebar();
    presentNotInstalled(silent);
    persistLastChecked();
    return;
  }

  if (current.state === "unknown") {
    versionState.state = "unknown";
    versionState.currentVersion = null;
    versionState.message = current.error || current.raw || "Unparsable version output.";
    refreshVersionSidebar();
    if (!silent) {
      showNotification("Version Unknown",
        "Could not parse `claude --version` output: " + versionState.message);
    }
    persistLastChecked();
    return;
  }

  versionState.currentVersion = current.version;

  let latest;
  try {
    latest = await UpdateCheck.getLatestVersion(channel);
  } catch (err) {
    versionState.state = "error";
    versionState.message = err.message;
    refreshVersionSidebar();
    if (!silent) showNotification("Update Check Failed", err.message);
    persistLastChecked();
    return;
  }

  versionState.latestVersion = latest.version;
  const cmp = UpdateCheck.semverCompare(current.version, latest.version);
  persistLastChecked();

  if (cmp === null) {
    versionState.state = "unknown";
    versionState.message = "Could not compare versions (" + current.version + " vs " + latest.version + ").";
    refreshVersionSidebar();
    return;
  }

  if (cmp >= 0) {
    versionState.state = "up_to_date";
    versionState.message = null;
    refreshVersionSidebar();
    if (!silent) {
      showNotification("Up to Date", "Claude Code is up to date (v" + current.version + ").");
    }
    return;
  }

  // Update available — always notify, even on silent auto-check.
  versionState.state = "update_available";
  versionState.message = "Update available: v" + current.version + " → v" + latest.version;
  refreshVersionSidebar();
  presentUpdateAvailable(current, latest);
}

function presentUpdateAvailable(current, latest) {
  const req = new NotificationRequest("claudecode-update-available");
  req.title = "Claude Code Update Available";
  req.body = "v" + current.version + " → v" + latest.version + ".\nUpdate will stop and restart the bridge.";
  req.actions = ["Update Now", "Release Notes", "Later"];

  nova.notifications.add(req).then(function(response) {
    if (response.actionIdx === 0) {
      const method = UpdateCheck.detectInstallMethod(current.path);
      runUpdateFlow(method);
    } else if (response.actionIdx === 1) {
      const url = "https://github.com/anthropics/claude-code/releases/tag/v" + latest.version;
      try { nova.openURL(url); }
      catch (err) {
        nova.clipboard.writeText(url);
        showNotification("Release Notes", "URL copied to clipboard: " + url);
      }
    }
    // "Later" → no-op; user can re-check via the sidebar or command.
  });
}

async function presentNotInstalled(silent) {
  if (silent && nova.config.get("claudecode.updateCheck.suppressNotInstalled") === true) {
    return;
  }

  const npmOk = !silent && (await UpdateCheck.isNpmAvailable());

  const req = new NotificationRequest("claudecode-not-installed");
  req.title = "Claude Code CLI Not Found";
  req.body = "The Claude Code CLI is not on PATH. The bridge runs without it, but you'll need it to launch Claude from Nova.";
  req.actions = ["Install Guide", "Configure Path"];
  if (npmOk) req.actions.push("Install via npm");
  if (silent) req.actions.push("Don't Show Again");

  nova.notifications.add(req).then(function(response) {
    const action = req.actions[response.actionIdx];
    if (action === "Install Guide") {
      const url = "https://docs.anthropic.com/claude-code/install";
      try { nova.openURL(url); }
      catch (_) {
        nova.clipboard.writeText(url);
        showNotification("Install Guide", "URL copied to clipboard: " + url);
      }
    } else if (action === "Configure Path") {
      try { nova.workspace.openConfig(nova.extension.identifier); }
      catch (err) {
        showNotification("Open Settings", "Could not open extension settings: " + err.message);
      }
    } else if (action === "Install via npm") {
      runInstallFlow();
    } else if (action === "Don't Show Again") {
      nova.config.set("claudecode.updateCheck.suppressNotInstalled", true);
    }
  });
}

async function runUpdateFlow(method) {
  if (updateInProgress) {
    showNotification("Update In Progress", "An update is already running.");
    return;
  }
  updateInProgress = true;

  const wasRunning = !!serverProcess;
  if (wasRunning) {
    stopBridge();
    await delay(500); // give the OS a moment to release the port
  }

  showNotification("Updating", "Updating Claude Code… the bridge will restart automatically.");
  const claudeCommand = nova.workspace.config.get("claudecode.claudeCommand") || "claude";

  let result;
  try {
    result = await UpdateCheck.runUpdate(method, claudeCommand);
  } catch (err) {
    console.error("Claude Code Bridge: update threw:", err.message);
    result = { success: false, stderr: err.message };
  }

  updateInProgress = false;

  if (result.success) {
    // Re-probe the new version so the sidebar reflects reality.
    try {
      const current = await UpdateCheck.getCurrentVersion(claudeCommand);
      if (current.state === "installed") {
        versionState.currentVersion = current.version;
        versionState.state = "up_to_date";
        versionState.message = null;
        refreshVersionSidebar();
      }
    } catch (_) {}

    showNotification("Update Complete",
      "Claude Code updated successfully" +
      (versionState.currentVersion ? " to v" + versionState.currentVersion : "") + ".");

    if (wasRunning) {
      setTimeout(function() {
        try { startBridge(); } catch (err) {
          console.error("Claude Code Bridge: post-update restart failed:", err.message);
          showNotification("Restart Failed", "Update succeeded but bridge restart failed: " + err.message);
        }
      }, 300);
    }
  } else {
    // Don't auto-restart the bridge on failure — leave the user in a stable
    // state so they can diagnose. The previous claude is still installed.
    const stderr = (result.stderr || "").trim();
    const req = new NotificationRequest("claudecode-update-failed");
    req.title = "Claude Code Update Failed";
    req.body = stderr ? stderr.slice(0, 500) : "Update command returned a non-zero exit code.";
    req.actions = ["Copy Log", "OK"];
    nova.notifications.add(req).then(function(response) {
      if (response.actionIdx === 0) {
        const full = "stdout:\n" + (result.stdout || "") + "\n\nstderr:\n" + (result.stderr || "");
        nova.clipboard.writeText(full);
      }
    });
  }
}

async function runInstallFlow() {
  if (updateInProgress) {
    showNotification("Install In Progress", "An install is already running.");
    return;
  }
  updateInProgress = true;
  showNotification("Installing", "Installing @anthropic-ai/claude-code globally via npm…");

  let result;
  try {
    result = await UpdateCheck.installViaNpm();
  } catch (err) {
    result = { success: false, stderr: err.message };
  }
  updateInProgress = false;

  if (result.success) {
    showNotification("Install Complete", "Claude Code installed. Run \"Check for Updates\" to refresh the sidebar.");
    // Trigger a re-check so the sidebar updates without user action.
    checkForUpdates(true).catch(function(_) {});
  } else {
    const req = new NotificationRequest("claudecode-install-failed");
    req.title = "Install Failed";
    req.body = (result.stderr || "npm install exited with a non-zero code.").slice(0, 500);
    req.actions = ["Copy Log", "OK"];
    nova.notifications.add(req).then(function(response) {
      if (response.actionIdx === 0) {
        nova.clipboard.writeText("stdout:\n" + (result.stdout || "") + "\n\nstderr:\n" + (result.stderr || ""));
      }
    });
  }
}

function persistLastChecked() {
  try {
    nova.config.set("claudecode.updateCheck.lastCheckedAt", Date.now());
    if (versionState.currentVersion) {
      nova.config.set("claudecode.updateCheck.lastSeenVersion", versionState.currentVersion);
    }
  } catch (err) {
    console.warn("Claude Code Bridge: could not persist lastCheckedAt:", err.message);
  }
  versionState.lastCheckedAt = Date.now();
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
