// bridge.js — Bridge lifecycle — spawn / stop ws-server.js, stdin/stdout JSON-lines protocol, server message dispatch.
//
// Split out of the former 3 500-line main.js (v0.28.0). Runs in Nova's
// JavaScriptCore runtime (CommonJS require, no Node built-ins). Nova's
// require() does NOT support circular dependencies (it recurses until
// "Maximum call stack size exceeded"), so modules never require each other:
// each one attaches its exports to the shared registry (R.<Name>) at the
// bottom, and cross-module calls dereference R.<Name>.fn at call time.

const S = require("./state.js");
const R = require("./registry.js");

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

async function startBridge() {
  if (S.serverProcess) {
    console.log("Claude Code Bridge: already running");
    R.Util.showNotification("Already Running", "Claude Code Bridge is already active.");
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
  // openDiff blocks until the user answers; tell ws-server how long main.js
  // keeps a diff alive so its safety-net deadline sits just past ours
  // (0 = diffs never expire → no deadline at all on the ws-server side).
  var diffMinutes = nova.config.get("claudecode.diffTimeoutMinutes");
  if (typeof diffMinutes !== "number" || !(diffMinutes >= 0)) diffMinutes = 30;
  const env = {
    CC_PORT_MIN: String(portMin),
    CC_PORT_MAX: String(portMax),
    CC_WORKSPACE: workspace,
    CC_DIFF_TIMEOUT_MS: String(diffMinutes === 0 ? 0 : diffMinutes * 60000 + 60000),
  };

  if (nova.config.get("claudecode.chat.enabled")) {
    try {
      const apiKey = await R.Chat.resolveChatApiKey();
      env.CC_CHAT_ENABLED = "1";
      env.CC_CHAT_PORT    = String(nova.config.get("claudecode.chat.port") || 5180);
      env.CC_CHAT_MODEL   = nova.config.get("claudecode.chat.model") || "claude-sonnet-5";
      S.chatState.token     = R.Chat.getOrCreateChatToken();
      env.CC_CHAT_TOKEN   = S.chatState.token;
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
        S.chatState.apiKeySource = await R.Chat.detectChatApiKeySource();
      } else {
        console.log("Claude Code Bridge: chat enabled (OAuth mode — no API key, uses your Claude Code login), port " + env.CC_CHAT_PORT + ", model " + env.CC_CHAT_MODEL);
        S.chatState.apiKeySource = "oauth";
      }

      S.chatState.state = "starting";
      S.chatState.port = parseInt(env.CC_CHAT_PORT, 10) || 5180;
      S.chatState.model = env.CC_CHAT_MODEL;
      S.chatState.lastError = null;
      S.chatState.url = R.Chat.chatUrlWithToken(S.chatState.port);
      R.Sidebar.refreshChatStatusSidebar();
    } catch (err) {
      console.error("Claude Code Bridge: chat API key resolution failed:", err.message);
      S.chatState.state = "failed";
      S.chatState.lastError = err.message;
      R.Sidebar.refreshChatStatusSidebar();
    }
  } else {
    S.chatState.state = "disabled";
    R.Sidebar.refreshChatStatusSidebar();
  }

  try {
    S.serverProcess = new Process(nodePath, {
      args: [scriptPath],
      env,
      cwd: workspace || undefined,
      stdio: "pipe",
    });
  } catch (err) {
    console.error("Claude Code Bridge: failed to create Process:", err.message);
    R.Util.showNotification("Error", "Cannot create server process: " + err.message);
    return;
  }

  // Reset stdout line buffer
  S.stdoutBuffer = "";

  // Read JSON lines from server stdout (may arrive as partial chunks)
  S.serverProcess.onStdout(function(chunk) {
    S.stdoutBuffer += chunk;
    var newlineIdx;
    while ((newlineIdx = S.stdoutBuffer.indexOf("\n")) !== -1) {
      var line = S.stdoutBuffer.slice(0, newlineIdx).trim();
      S.stdoutBuffer = S.stdoutBuffer.slice(newlineIdx + 1);
      if (line.length === 0) continue;
      try {
        handleServerMessage(JSON.parse(line));
      } catch (err) {
        console.error("Claude Code Bridge: failed to parse server message:", line, err.message);
      }
    }
  });

  S.serverProcess.onStderr(function(data) {
    console.warn("Claude Code Bridge [server stderr]: " + data.trim());
  });

  S.serverProcess.onDidExit(function(exitCode) {
    console.log("Claude Code Bridge: server exited with code " + exitCode);
    S.serverProcess = null;
    S.serverPort = null;
    S.isConnected = false;
    S.clientCount = 0;
    S.stdoutBuffer = "";
    R.Sidebar.updateSidebar();
    // Chat lives inside the ws-server subprocess — if the subprocess died,
    // chat is gone too. Only downgrade to "stopped" if we hadn't already
    // recorded a more specific failure (chat_failed sets "failed").
    if (S.chatState.state !== "disabled" && S.chatState.state !== "failed") {
      S.chatState.state = "stopped";
      R.Sidebar.refreshChatStatusSidebar();
    }
    if (exitCode !== 0) {
      R.Util.showNotification("Server Stopped", "WebSocket server exited with code " + exitCode + ". Check Extension Console for details.");
    }
  });

  try {
    S.serverProcess.start();
    console.log("Claude Code Bridge: process started successfully");
  } catch (err) {
    console.error("Claude Code Bridge: process.start() failed:", err.message);
    R.Util.showNotification("Error", "Cannot start node process: " + err.message + "\nConfigure the Node.js path in extension settings.");
    S.serverProcess = null;
    return;
  }

  // Start tracking editor selection
  var trackSelection = nova.config.get("claudecode.trackSelection");
  if (trackSelection !== false) {
    R.Selection.startSelectionTracking();
  }

  // Refresh the git branch cache now so it's already populated for the
  // first selection_update / getWorkspaceFolders call.
  R.Sidebar.refreshGitBranch();

  R.Util.showNotification("Starting", "Claude Code Bridge is starting…");
}

function stopBridge() {
  if (S.serverProcess) {
    console.log("Claude Code Bridge: stopping server…");
    try { S.serverProcess.terminate(); } catch (_) {}
    S.serverProcess = null;
    S.serverPort = null;
    S.isConnected = false;
    S.clientCount = 0;
    S.stdoutBuffer = "";
    R.Sidebar.updateSidebar();
    R.Util.showNotification("Stopped", "Claude Code Bridge has been stopped.");
  }
}

// Stop + start with a short delay so the OS releases the port before we rebind.
// Useful after changing the port range or the Node.js path.
function restartBridge() {
  var wasRunning = !!S.serverProcess;
  stopBridge();
  setTimeout(function() {
    try {
      startBridge();
      if (wasRunning) {
        R.Util.showNotification("Restarted", "Claude Code Bridge has been restarted.");
      }
    } catch (err) {
      console.error("Claude Code Bridge: restart failed:", err.message);
      R.Util.showNotification("Restart Failed", err.message);
    }
  }, 300);
}

function sendToServer(obj) {
  if (!S.serverProcess) return;
  try {
    var writer = S.serverProcess.stdin.getWriter();
    writer.write(JSON.stringify(obj) + "\n");
    writer.releaseLock();
  } catch (err) {
    console.error("Claude Code Bridge: failed to send to server:", err.message);
  }
}

function handleServerMessage(msg) {
  switch (msg.type) {
    case "server_started":
      S.serverPort = msg.port;
      console.log("Claude Code Bridge: server started on port " + msg.port);
      R.Util.showNotification(
        "Ready",
        "WebSocket MCP server on port " + msg.port + ".\nUse \"Launch Claude\" command, or run:\nCLAUDE_CODE_SSE_PORT=" + msg.port + " ENABLE_IDE_INTEGRATION=true claude"
      );
      R.Sidebar.updateSidebar();
      break;

    case "client_connected":
      S.isConnected = true;
      S.clientCount = msg.clientCount || 1;
      console.log("Claude Code Bridge: Claude Code client connected");
      R.Util.showNotification("Connected", "Claude Code is now connected to Nova!");
      R.Sidebar.updateSidebar();
      break;

    case "client_disconnected":
      S.clientCount = msg.clientCount || 0;
      S.isConnected = S.clientCount > 0;
      R.Sidebar.updateSidebar();
      break;

    case "client_identified":
      // Claude Code sent its `ide_connected` notification with its pid.
      console.log("Claude Code Bridge: connected claude process pid " + (msg.pid || "?"));
      break;

    case "tool_call":
      R.Tools.handleToolCall(msg);
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
      S.chatState.state = "running";
      S.chatState.port = msg.port || S.chatState.port;
      if (msg.token) S.chatState.token = msg.token;   // ws-server minted one if ours was missing
      S.chatState.url = R.Chat.chatUrlWithToken(S.chatState.port);
      S.chatState.lastError = null;
      R.Sidebar.refreshChatStatusSidebar();
      R.Util.showNotification(
        "Chat UI ready",
        "Claude chat is live at " + R.Chat.chatBaseUrl(S.chatState.port) + "\nUse the \"Open Claude Chat in Browser\" command — it opens/copies the URL with the required access token."
      );
      break;

    case "chat_failed":
      console.error("Claude Code Bridge: chat server failed — " + msg.message);
      S.chatState.state = "failed";
      S.chatState.lastError = msg.message || "unknown error";
      R.Sidebar.refreshChatStatusSidebar();
      R.Util.showNotification("Chat UI failed to start", msg.message);
      break;
  }
}

function showStatus() {
  var lines = [
    "Claude Code Bridge Status",
    "------------------------",
    "Server: " + (S.serverProcess ? "Running" : "Stopped"),
    "Port: " + (S.serverPort || "N/A"),
    "Connected clients: " + S.clientCount,
    "Workspace: " + (nova.workspace.path || "N/A"),
  ];

  var notification = new NotificationRequest("claudecode-status");
  notification.title = "Claude Code Bridge";
  notification.body = lines.join("\n");
  notification.actions = S.serverProcess ? ["Stop Bridge", "OK"] : ["Start Bridge", "OK"];

  nova.notifications.add(notification).then(function(response) {
    if (response.actionIdx === 0) {
      if (S.serverProcess) {
        stopBridge();
      } else {
        startBridge();
      }
    }
  });
}

R.Bridge = Object.assign(R.Bridge || {}, {
  resolveNodePath,
  startBridge,
  stopBridge,
  restartBridge,
  sendToServer,
  handleServerMessage,
  showStatus,
});
module.exports = R.Bridge;
