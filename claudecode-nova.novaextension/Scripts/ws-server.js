#!/usr/bin/env node
/**
 * Claude Code ↔ Nova — WebSocket MCP Bridge Server
 * 
 * This Node.js helper runs as a subprocess spawned by the Nova extension.
 * It implements:
 *   1. A WebSocket server (RFC 6455) on localhost
 *   2. The lock-file discovery mechanism (~/.claude/ide/<port>.lock)
 *   3. JSON-RPC 2.0 message routing (MCP protocol)
 *   4. Bidirectional communication with the Nova extension via stdin/stdout JSON lines
 *
 * Protocol reference: coder/claudecode.nvim PROTOCOL.md
 */

const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const os = require("os");
const net = require("net");

// ---------------------------------------------------------------------------
// Configuration (passed via env or CLI args)
// ---------------------------------------------------------------------------
const PORT_MIN  = parseInt(process.env.CC_PORT_MIN  || "10000", 10);
const PORT_MAX  = parseInt(process.env.CC_PORT_MAX  || "65535", 10);
const WORKSPACE = process.env.CC_WORKSPACE || process.cwd();
const IDE_NAME  = "Nova";

// Chat UI (Mode B — opt-in chat panel in Nova Preview tab).
// Enabled when CC_CHAT_ENABLED=1 is set by main.js at spawn time.
// API key flows via ANTHROPIC_API_KEY (resolved from 1Password / Keychain
// in main.js before spawning this subprocess).
const CHAT_ENABLED = process.env.CC_CHAT_ENABLED === "1" || process.env.CC_CHAT_ENABLED === "true";
const CHAT_PORT    = parseInt(process.env.CC_CHAT_PORT || "5180", 10);
const CHAT_MODEL   = process.env.CC_CHAT_MODEL || "claude-sonnet-5";
const CHAT_API_KEY = process.env.ANTHROPIC_API_KEY || "";
// Shared secret for the chat (/ws) and terminal (/cli) WebSockets. main.js
// generates + persists it and passes it down; if it's ever missing we mint
// one here and report it back in `chat_started` so main.js can build URLs.
const CHAT_TOKEN   = process.env.CC_CHAT_TOKEN || crypto.randomUUID();

// getDiagnostics fallback: Nova has no API for other extensions' LSP
// diagnostics, so we answer this tool here by running the project's own
// linters (tsc / eslint / ruff — see diagnostics.js). main.js is told about
// each call so it still shows up in the sidebar's Tool Calls log.
const DIAGNOSTICS_ENABLED = process.env.CC_DIAGNOSTICS !== "0";
const DIAGNOSTICS_TIMEOUT_MS = (() => {
  const n = parseInt(process.env.CC_DIAGNOSTICS_TIMEOUT_MS || "", 10);
  return Number.isFinite(n) && n >= 1000 ? n : 20000;
})();
let diagnosticsModule = null;
function diagnostics() {
  if (!diagnosticsModule) diagnosticsModule = require("./diagnostics.js");
  return diagnosticsModule;
}

// Returns the MCP result payload for getDiagnostics, or null when the
// fallback is disabled (caller then forwards to Nova as before).
async function runLocalDiagnostics(args) {
  if (!DIAGNOSTICS_ENABLED) return null;
  const started = Date.now();
  let result;
  try {
    result = await diagnostics().runDiagnostics({
      workspace: WORKSPACE,
      uri: args && args.uri,
      timeoutMs: DIAGNOSTICS_TIMEOUT_MS,
      log,
    });
  } catch (err) {
    log("error", `diagnostics: ${err.message}`);
    result = { files: [], sources: [], summary: `diagnostics failed: ${err.message}` };
  }
  const total = result.files.reduce((n, f) => n + f.diagnostics.length, 0);
  sendToNova({
    type: "tool_call_local",
    tool: "getDiagnostics",
    arguments: args || {},
    result: { count: total, files: result.files.length, summary: result.summary, ms: Date.now() - started },
  });
  return {
    content: [
      { type: "text", text: JSON.stringify(result.files) },
      { type: "text", text: `Sources — ${result.summary || "no linter detected in workspace"}` },
    ],
  };
}
let chatHandle = null;  // { port, stop() } once chat-session.mjs is initialized
let cliHandle = null;   // { pushResumeRequest(sessionId), stop() } once cli-session.mjs is attached

// Per-tool response deadlines. Most Nova tools answer in milliseconds, so
// 30 s is a generous default. Two tools legitimately block on the human:
//   - openDiff waits for Accept/Reject. main.js already auto-rejects diffs
//     older than `claudecode.diffTimeoutMinutes` (sent here as
//     CC_DIFF_TIMEOUT_MS, 0 = never), so we only keep a safety net one
//     minute past that. Before this, a 30 s cap here silently timed out
//     every diff the user took longer than half a minute to review, and
//     the eventual Accept found no pending request to answer.
//   - askUser blocks on a native modal.
const TOOL_TIMEOUT_MS      = 30000;
const ASK_USER_TIMEOUT_MS  = 10 * 60 * 1000;
const DIFF_TIMEOUT_MS      = (() => {
  const n = parseInt(process.env.CC_DIFF_TIMEOUT_MS || "", 10);
  return Number.isFinite(n) && n >= 0 ? n : 31 * 60 * 1000;
})();

function toolTimeoutMs(toolName) {
  if (toolName === "openDiff") return DIFF_TIMEOUT_MS;   // 0 → no deadline
  if (toolName === "askUser")  return ASK_USER_TIMEOUT_MS;
  if (toolName === "getDiagnostics") return Math.max(TOOL_TIMEOUT_MS, DIAGNOSTICS_TIMEOUT_MS + 5000);
  return TOOL_TIMEOUT_MS;
}

// Arm a deadline for a pending tool call. Returns null when the tool has
// no deadline (openDiff with diffTimeoutMinutes = 0).
function armToolTimeout(toolName, onTimeout) {
  const ms = toolTimeoutMs(toolName);
  if (!ms) return null;
  return setTimeout(onTimeout, ms);
}

// Bridge version advertised in the MCP `initialize` reply — read from the
// manifest so it stops drifting (it was hardcoded at "0.2.0").
const BRIDGE_VERSION = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, "..", "extension.json"), "utf8")).version || "0.0.0";
  } catch (_) { return "0.0.0"; }
})();

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------
function generateAuthToken() {
  return crypto.randomUUID();
}

function log(level, msg, data) {
  sendToNova({ type: "log", level, message: msg, data });
}

function sendToNova(obj) {
  try {
    process.stdout.write(JSON.stringify(obj) + "\n");
  } catch (_) { /* stdout closed */ }
}

// stdout is our pipe to main.js. If Nova (or a test harness) goes away
// first, later writes raise EPIPE asynchronously on the stream — which is
// not caught by the try/catch above and would crash us with a stack trace.
// Treat a dead parent as a shutdown signal instead.
process.stdout.on("error", (err) => {
  if (err && (err.code === "EPIPE" || err.code === "ERR_STREAM_DESTROYED")) {
    shutdown("stdout closed by parent");
  }
});

// ---------------------------------------------------------------------------
// Shutdown — single exit path for SIGTERM, a closed pipe and a lost parent
// ---------------------------------------------------------------------------
let shuttingDown = false;

function shutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  // Best-effort: stdout may already be gone, and log() swallows that.
  log("info", `Shutting down (${reason})`);
  try { if (serverPort) removeLockFile(serverPort); } catch (_) {}
  for (const client of connectedClients) {
    try { client.socket.destroy(); } catch (_) {}
  }
  if (chatHandle) {
    try { chatHandle.stop(); } catch (_) {}
  }
  process.exit(0);
}

// The EPIPE handler above only fires on our *next write*. An idle server
// never writes, so when Nova crashes (no deactivate(), no SIGTERM — seen
// 2026-09-24 with a SIGTRAP in Nova 14.1) the helper outlived Nova
// indefinitely: stale lock file in ~/.claude/ide, and the chat port held
// hostage so the next Nova start got EADDRINUSE on 5180. Two cheap signals
// catch that case without waiting for a write:
//   1. stdin reaches EOF — the extension service's end of the pipe closed.
//   2. We are re-parented to launchd (ppid === 1). Nova spawns us directly
//      (no shell), so any ppid change means the extension service is gone.
process.stdin.on("end", () => shutdown("stdin closed"));
process.stdin.on("close", () => shutdown("stdin closed"));

const PARENT_POLL_MS = 5000;
setInterval(() => {
  if (process.ppid === 1) shutdown("parent process exited");
}, PARENT_POLL_MS).unref();

// ---------------------------------------------------------------------------
// Lock file management
// ---------------------------------------------------------------------------
function getLockDir() {
  const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
  return path.join(configDir, "ide");
}

function writeLockFile(port, authToken) {
  const dir = getLockDir();
  fs.mkdirSync(dir, { recursive: true });
  const lockPath = path.join(dir, `${port}.lock`);
  const lockData = {
    pid: process.pid,
    workspaceFolders: [WORKSPACE],
    ideName: IDE_NAME,
    transport: "ws",
    authToken,
  };
  fs.writeFileSync(lockPath, JSON.stringify(lockData, null, 2));
  log("info", `Lock file written: ${lockPath}`);
  return lockPath;
}

function removeLockFile(port) {
  try {
    const lockPath = path.join(getLockDir(), `${port}.lock`);
    fs.unlinkSync(lockPath);
    log("info", `Lock file removed: ${lockPath}`);
  } catch (_) {}
}

// ---------------------------------------------------------------------------
// Find an available port
// ---------------------------------------------------------------------------
function findPort(min, max) {
  return new Promise((resolve, reject) => {
    const port = min + Math.floor(Math.random() * (max - min));
    const server = net.createServer();
    server.once("error", () => {
      if (port < max) {
        findPort(min, max).then(resolve).catch(reject);
      } else {
        reject(new Error("No available port found"));
      }
    });
    server.once("listening", () => {
      server.close(() => resolve(port));
    });
    server.listen(port, "127.0.0.1");
  });
}

// ---------------------------------------------------------------------------
// WebSocket frame helpers (RFC 6455)
// ---------------------------------------------------------------------------
function parseFrame(buffer) {
  if (buffer.length < 2) return null;

  const firstByte  = buffer[0];
  const secondByte = buffer[1];
  const fin    = (firstByte & 0x80) !== 0;
  const opcode = firstByte & 0x0f;
  const masked = (secondByte & 0x80) !== 0;
  let payloadLen = secondByte & 0x7f;
  let offset = 2;

  if (payloadLen === 126) {
    if (buffer.length < 4) return null;
    payloadLen = buffer.readUInt16BE(2);
    offset = 4;
  } else if (payloadLen === 127) {
    if (buffer.length < 10) return null;
    payloadLen = Number(buffer.readBigUInt64BE(2));
    offset = 10;
  }

  if (masked) {
    if (buffer.length < offset + 4 + payloadLen) return null;
    const mask = buffer.slice(offset, offset + 4);
    offset += 4;
    const payload = Buffer.alloc(payloadLen);
    for (let i = 0; i < payloadLen; i++) {
      payload[i] = buffer[offset + i] ^ mask[i % 4];
    }
    return { fin, opcode, payload, totalLength: offset + payloadLen };
  } else {
    if (buffer.length < offset + payloadLen) return null;
    const payload = buffer.slice(offset, offset + payloadLen);
    return { fin, opcode, payload, totalLength: offset + payloadLen };
  }
}

function createFrame(data, opcode = 0x01) {
  const payload = typeof data === "string" ? Buffer.from(data, "utf8") : data;
  const len = payload.length;
  let header;

  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x80 | opcode;
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

// ---------------------------------------------------------------------------
// MCP Tool registry — tools that Claude Code expects
// ---------------------------------------------------------------------------
const tools = {};
let pendingRequests = {};  // id → { resolve, reject }

/**
 * All tool handlers forward the call to Nova and return a Promise
 * that resolves when Nova sends back the result.
 */
function registerTool(name, schema, description) {
  tools[name] = { schema, description };
}

// Register the 12 MCP tools that Claude Code expects, matching the VS Code /
// Neovim PROTOCOL.md schemas verbatim. Param names and casing here are the
// contract Claude consumes via tools/list — don't deviate.
registerTool("openFile", {
  type: "object",
  properties: {
    filePath:           { type: "string",  description: "Path to the file to open" },
    preview:            { type: "boolean", description: "Open in preview mode",                 default: false },
    startText:          { type: "string",  description: "Text pattern marking selection start" },
    endText:            { type: "string",  description: "Text pattern marking selection end" },
    selectToEndOfLine:  { type: "boolean", description: "Extend selection to end of line",      default: false },
    makeFrontmost:      { type: "boolean", description: "Make the file the active editor tab", default: true },
  },
  required: ["filePath"],
}, "Open a file in the editor and optionally select a range of text");

registerTool("openDiff", {
  type: "object",
  properties: {
    old_file_path:     { type: "string", description: "Path to original file" },
    new_file_path:     { type: "string", description: "Path to new file" },
    new_file_contents: { type: "string", description: "Contents of the new file" },
    tab_name:          { type: "string", description: "Tab name for the diff view" },
  },
  required: ["old_file_path", "new_file_path", "new_file_contents", "tab_name"],
}, "Open a git diff for the file (blocking operation)");

registerTool("getCurrentSelection", {
  type: "object", properties: {},
}, "Get the current text selection in the active editor");

registerTool("getLatestSelection", {
  type: "object", properties: {},
}, "Get the most recent text selection (even if not in active editor)");

registerTool("getOpenEditors", {
  type: "object", properties: {},
}, "Get information about currently open editors");

registerTool("getWorkspaceFolders", {
  type: "object", properties: {},
}, "Get all workspace folders currently open in the IDE");

registerTool("checkDocumentDirty", {
  type: "object",
  properties: {
    filePath: { type: "string", description: "Path to the file to check" },
  },
  required: ["filePath"],
}, "Check if a document has unsaved changes (is dirty)");

registerTool("saveDocument", {
  type: "object",
  properties: {
    filePath: { type: "string", description: "Path to the file to save" },
  },
  required: ["filePath"],
}, "Save a document with unsaved changes");

registerTool("getDiagnostics", {
  type: "object",
  properties: {
    uri: { type: "string", description: "File URI to get diagnostics for. If not provided, gets diagnostics for all files." },
  },
}, "Get language diagnostics for the workspace: runs the project's own linters (TypeScript tsc, ESLint, Ruff — whichever are configured) and returns their errors and warnings. Pass a file URI to scope to one file.");

registerTool("close_tab", {
  type: "object",
  properties: {
    tab_name: { type: "string", description: "Name of the tab to close" },
  },
  required: ["tab_name"],
}, "Close a tab by name");

registerTool("closeAllDiffTabs", {
  type: "object", properties: {},
}, "Close all diff tabs in the editor");

registerTool("executeCode", {
  type: "object",
  properties: {
    code: { type: "string", description: "The code to be executed on the kernel" },
  },
  required: ["code"],
}, "Execute Python code in the Jupyter kernel for the current notebook file");

// ---------------------------------------------------------------------------
// MCP message handling
// ---------------------------------------------------------------------------
let connectedClients = [];

function buildToolsListResponse() {
  return Object.entries(tools).map(([name, { schema, description }]) => ({
    name,
    description,
    inputSchema: schema,
  }));
}

function handleMCPMessage(client, message) {
  try {
    const msg = JSON.parse(message);

    // JSON-RPC 2.0 request
    if (msg.method && msg.id !== undefined) {
      handleRequest(client, msg);
    }
    // JSON-RPC 2.0 notification (no id)
    else if (msg.method && msg.id === undefined) {
      handleNotification(client, msg);
    }
    // JSON-RPC 2.0 response
    else if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      // Response to a request we made — not expected in current flow
      log("debug", "Received response from Claude", msg);
    }
  } catch (err) {
    log("error", `Failed to parse MCP message: ${err.message}`);
  }
}

function handleRequest(client, msg) {
  const { method, params, id } = msg;

  if (method === "initialize") {
    sendWSMessage(client, {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "nova-claudecode-bridge", version: BRIDGE_VERSION },
      },
    });
    return;
  }

  if (method === "tools/list") {
    sendWSMessage(client, {
      jsonrpc: "2.0",
      id,
      result: { tools: buildToolsListResponse() },
    });
    return;
  }

  if (method === "tools/call") {
    const toolName = params?.name;
    const toolArgs = params?.arguments || {};

    if (!tools[toolName]) {
      sendWSMessage(client, {
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Unknown tool: ${toolName}` },
      });
      return;
    }

    if (toolName === "getDiagnostics" && DIAGNOSTICS_ENABLED) {
      runLocalDiagnostics(toolArgs).then((payload) => {
        sendWSMessage(client, { jsonrpc: "2.0", id, result: payload });
      });
      return;
    }

    // Forward to Nova extension and wait for response
    const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    
    sendToNova({
      type: "tool_call",
      requestId,
      tool: toolName,
      arguments: toolArgs,
      mcpId: id,
    });

    // Store pending — Nova will respond with tool_result (or diff_response
    // for openDiff). Deadline is per-tool: see toolTimeoutMs().
    pendingRequests[requestId] = {
      client,
      mcpId: id,
      timeout: armToolTimeout(toolName, () => {
        delete pendingRequests[requestId];
        log("warn", `Tool ${toolName} timed out after ${toolTimeoutMs(toolName)} ms`);
        sendWSMessage(client, {
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "text", text: JSON.stringify({ error: "Tool call timed out" }) }],
          },
        });
      }),
    };
    return;
  }

  // Unknown method
  sendWSMessage(client, {
    jsonrpc: "2.0",
    id,
    error: { code: -32601, message: `Method not found: ${method}` },
  });
}

function handleNotification(client, msg) {
  const { method, params } = msg;

  if (method === "notifications/initialized") {
    log("info", "Claude Code client initialized");
    sendToNova({ type: "client_connected", clientCount: connectedClients.length });
    return;
  }

  // Claude Code announces its own process id right after the handshake
  // (same as it does for the VS Code / JetBrains plugins). Remember it on
  // the client so logs and the sidebar can name the session.
  if (method === "ide_connected") {
    client.pid = params && params.pid;
    log("info", `Claude Code client identified (pid ${client.pid ?? "?"})`);
    sendToNova({ type: "client_identified", pid: client.pid ?? null, clientCount: connectedClients.length });
    return;
  }

  log("debug", `Notification: ${method}`, params);
}

function sendWSMessage(client, obj) {
  try {
    const frame = createFrame(JSON.stringify(obj));
    client.socket.write(frame);
  } catch (err) {
    log("error", `Failed to send WS message: ${err.message}`);
  }
}

// Broadcast a notification to all connected Claude clients
function broadcastNotification(method, params) {
  const msg = { jsonrpc: "2.0", method, params };
  for (const client of connectedClients) {
    sendWSMessage(client, msg);
  }
}

// ---------------------------------------------------------------------------
// Handle messages FROM Nova extension (via stdin)
// ---------------------------------------------------------------------------
let stdinBuffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  stdinBuffer += chunk;
  let newlineIdx;
  while ((newlineIdx = stdinBuffer.indexOf("\n")) !== -1) {
    const line = stdinBuffer.slice(0, newlineIdx);
    stdinBuffer = stdinBuffer.slice(newlineIdx + 1);
    if (line.trim()) {
      try {
        handleNovaMessage(JSON.parse(line));
      } catch (err) {
        log("error", `Failed to parse Nova message: ${err.message}`);
      }
    }
  }
});

// Format a Nova tool result into the MCP `content` payload shape.
// Pure function — used by both the MCP path and the chat path.
function formatToolResultPayload(result) {
  const isErr = result && typeof result === "object" && result.error;
  const text = (typeof result === "string")
    ? result
    : JSON.stringify(isErr ? { error: result.error } : result);
  const payload = { content: [{ type: "text", text }] };
  if (isErr) payload.isError = true;
  return payload;
}

// Chat-originated Nova tool call. Returns a Promise that resolves with the
// MCP-shaped payload when main.js sends back the tool_result. Shares the
// pendingRequests map with the MCP path via `kind: "chat"`.
function callNovaTool(toolName, args) {
  if (toolName === "getDiagnostics" && DIAGNOSTICS_ENABLED) return runLocalDiagnostics(args);
  return new Promise((resolve, reject) => {
    const requestId = `chat_req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const timeout = armToolTimeout(toolName, () => {
      if (pendingRequests[requestId]) {
        delete pendingRequests[requestId];
        reject(new Error(`Nova tool ${toolName} timed out after ${toolTimeoutMs(toolName)} ms`));
      }
    });
    pendingRequests[requestId] = { kind: "chat", resolve, reject, timeout };
    sendToNova({
      type: "tool_call",
      requestId,
      tool: toolName,
      arguments: args,
    });
  });
}

function handleNovaMessage(msg) {
  // Resume requests forwarded from main.js when the user clicks a
  // Recent Sessions row in the Nova sidebar. Dispatched to the chat
  // or cli session module which broadcasts to its live ws clients.
  if (msg.type === "resume_in_chat" && msg.sessionId) {
    if (chatHandle && typeof chatHandle.pushResumeRequest === "function") {
      chatHandle.pushResumeRequest(msg.sessionId);
    }
    return;
  }
  if (msg.type === "resume_in_cli" && msg.sessionId) {
    if (cliHandle && typeof cliHandle.pushResumeRequest === "function") {
      cliHandle.pushResumeRequest(msg.sessionId);
    }
    return;
  }

  // Tool result from Nova — dispatch by kind to the right resolver
  if (msg.type === "tool_result" && msg.requestId) {
    const pending = pendingRequests[msg.requestId];
    if (pending) {
      clearTimeout(pending.timeout);
      delete pendingRequests[msg.requestId];

      const payload = formatToolResultPayload(msg.result);

      if (pending.kind === "chat") {
        // Chat-originated — resolve the Promise the chat tool wrapper awaits
        pending.resolve(payload);
      } else {
        // MCP-originated (default — backward compat) — send WS response
        sendWSMessage(pending.client, {
          jsonrpc: "2.0",
          id: pending.mcpId,
          result: payload,
        });
      }
    }
    return;
  }

  // Selection update broadcast — method name matches Neovim/VS Code protocol
  // (no `notifications/` prefix). Claude Code uses this to track the current
  // editor selection (visible via getCurrentSelection / getLatestSelection).
  // The internal format from main.js uses flat startLine/endLine fields; we
  // reshape it here into the nested {selection: {start, end, isEmpty}} that
  // the protocol expects.
  if (msg.type === "selection_update") {
    const d = msg.data || {};
    const params = {
      text: d.text || "",
      filePath: d.filePath || null,
      fileUrl: d.filePath ? "file://" + d.filePath : null,
      selection: {
        start: { line: d.startLine || 0, character: d.startColumn || 0 },
        end:   { line: d.endLine   || 0, character: d.endColumn   || 0 },
        isEmpty: d.isEmpty || false,
      },
    };
    broadcastNotification("selection_changed", params);
    return;
  }

  // At-mention broadcast — adds a file or selection to Claude's context
  // (the equivalent of typing `@filename` in the REPL). Method name matches
  // the protocol used by VS Code and Neovim clients.
  if (msg.type === "at_mention") {
    broadcastNotification("at_mentioned", msg.data);
    return;
  }

  // Diagnostics update broadcast
  if (msg.type === "diagnostics_update") {
    broadcastNotification("notifications/diagnosticsChanged", msg.data);
    return;
  }

  // Diff response (accept/reject)
  if (msg.type === "diff_response" && msg.requestId) {
    const pending = pendingRequests[msg.requestId];
    if (pending) {
      clearTimeout(pending.timeout);
      delete pendingRequests[msg.requestId];

      const resultText = msg.accepted ? "FILE_SAVED" : "DIFF_REJECTED";
      // Happy path: plain string per PROTOCOL.md ("FILE_SAVED" / "DIFF_REJECTED").
      // User-edit path: JSON envelope carrying the post-edit content so Claude
      // can reconcile its plan with what actually hit disk (mirrors v2.1.110
      // Write+IDE diff awareness). Strictly additive — only emitted when the
      // user typed in the proposed-changes tab before Accept.
      let text = resultText;
      if (msg.userEdited) {
        const payload = { result: resultText, userEdited: true };
        if (msg.finalContent !== undefined) payload.finalContent = msg.finalContent;
        text = JSON.stringify(payload);
      }
      sendWSMessage(pending.client, {
        jsonrpc: "2.0",
        id: pending.mcpId,
        result: {
          content: [{ type: "text", text }],
        },
      });
    }
    return;
  }
}

// ---------------------------------------------------------------------------
// WebSocket upgrade & HTTP server
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Claude Code hook relay — POST /hook
// ---------------------------------------------------------------------------
// hook-relay.sh (installed into ~/.claude/settings.json by the extension)
// forwards Claude Code hook events here: SessionStart, UserPromptSubmit,
// PreToolUse, PostToolUse, PermissionRequest, Notification, Stop,
// StopFailure, SessionEnd. Same auth token as the MCP WebSocket (it is in
// the lock file the relay reads), localhost only. We do not interpret the
// event — main.js owns the per-session state machine — we just forward it,
// tagged with whether it came from the chat panel's own Claude session so
// Nova can skip notifications the chat UI already surfaces.
const HOOK_BODY_MAX = 1024 * 1024;

function isLocalAddress(addr) {
  return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
}

function handleHookRequest(req, res) {
  if (!isLocalAddress(req.socket.remoteAddress)) {
    res.writeHead(403); res.end(); return;
  }
  const auth = req.headers["authorization"] || "";
  if (auth !== `Bearer ${authToken}`) {
    log("warn", "Rejected /hook: invalid auth token");
    res.writeHead(401); res.end(); return;
  }
  let body = "";
  let tooLarge = false;
  req.setEncoding("utf8");
  req.on("data", (chunk) => {
    if (tooLarge) return;
    body += chunk;
    if (body.length > HOOK_BODY_MAX) { tooLarge = true; body = ""; }
  });
  req.on("end", () => {
    if (tooLarge) { res.writeHead(413); res.end(); return; }
    let event;
    try { event = JSON.parse(body); }
    catch (_) { res.writeHead(400); res.end(); return; }
    if (!event || typeof event !== "object" || typeof event.hook_event_name !== "string") {
      res.writeHead(400); res.end(); return;
    }
    let fromChat = false;
    try {
      fromChat = !!(chatHandle && typeof chatHandle.ownsSession === "function"
        && chatHandle.ownsSession(event.session_id));
    } catch (_) { /* never let a chat-side hiccup drop a hook event */ }
    sendToNova({ type: "hook_event", event, fromChat });
    res.writeHead(204); res.end();
  });
  req.on("error", () => { try { res.writeHead(400); res.end(); } catch (_) {} });
}

let serverPort = null;
let lockFilePath = null;
let authToken = null;

async function startServer() {
  authToken = generateAuthToken();

  const port = await findPort(PORT_MIN, PORT_MAX);
  serverPort = port;

  const httpServer = http.createServer((req, res) => {
    if (req.method === "POST" && req.url === "/hook") {
      handleHookRequest(req, res);
      return;
    }
    res.writeHead(404);
    res.end();
  });

  httpServer.on("upgrade", (req, socket, head) => {
    // Validate auth token
    const clientAuth = req.headers["x-claude-code-ide-authorization"];
    if (clientAuth !== authToken) {
      log("warn", "Rejected connection: invalid auth token");
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    // Validate origin is localhost
    const remoteAddr = socket.remoteAddress;
    if (remoteAddr !== "127.0.0.1" && remoteAddr !== "::1" && remoteAddr !== "::ffff:127.0.0.1") {
      log("warn", `Rejected connection from non-localhost: ${remoteAddr}`);
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }

    // Complete WebSocket handshake
    const key = req.headers["sec-websocket-key"];
    if (!key) {
      socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
      socket.destroy();
      return;
    }

    // RFC 6455 §1.3 — magic GUID concatenated with the client's
    // Sec-WebSocket-Key to compute Sec-WebSocket-Accept. The previous
    // value here had transposed digits, which made every `ws`-library
    // client (including Claude Code CLI) close with ECONNRESET ~5 ms
    // after the 101 handshake.
    const acceptKey = crypto
      .createHash("sha1")
      .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
      .digest("base64");

    // Echo back the first requested subprotocol. The `ws` Node.js library
    // (used by Claude Code CLI) hard-resets the TCP connection right after
    // the 101 if the client offered subprotocols and the server selected
    // none — symptom: ECONNRESET ~5 ms after "client connected".
    const offeredProtocols = (req.headers["sec-websocket-protocol"] || "")
      .split(",").map((s) => s.trim()).filter(Boolean);
    const selectedProtocol = offeredProtocols[0] || null;

    let responseHeaders =
      "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${acceptKey}\r\n`;
    if (selectedProtocol) {
      responseHeaders += `Sec-WebSocket-Protocol: ${selectedProtocol}\r\n`;
    }
    responseHeaders += "\r\n";
    socket.write(responseHeaders);

    // Client connected
    const client = { socket, buffer: Buffer.alloc(0) };
    connectedClients.push(client);
    log("info", "Claude Code client connected via WebSocket");
    sendToNova({ type: "client_connected", clientCount: connectedClients.length });
    if (chatHandle && typeof chatHandle.pushBridgeStatus === "function") {
      chatHandle.pushBridgeStatus({ port: serverPort, clientCount: connectedClients.length });
    }

    socket.on("data", (data) => {
      client.buffer = Buffer.concat([client.buffer, data]);

      let frame;
      while ((frame = parseFrame(client.buffer)) !== null) {
        client.buffer = client.buffer.slice(frame.totalLength);

        switch (frame.opcode) {
          case 0x01: // Text frame
            handleMCPMessage(client, frame.payload.toString("utf8"));
            break;
          case 0x08: // Close
            log("info", "Claude Code client sent close frame");
            socket.end(createFrame(Buffer.alloc(0), 0x08));
            break;
          case 0x09: // Ping
            socket.write(createFrame(frame.payload, 0x0a)); // Pong
            break;
          case 0x0a: // Pong
            break;
        }
      }
    });

    socket.on("close", (hadError) => {
      connectedClients = connectedClients.filter((c) => c !== client);
      log("info", `Claude Code client disconnected (hadError=${hadError})`);
      sendToNova({ type: "client_disconnected", clientCount: connectedClients.length });
      if (chatHandle && typeof chatHandle.pushBridgeStatus === "function") {
        chatHandle.pushBridgeStatus({ port: serverPort, clientCount: connectedClients.length });
      }
    });

    socket.on("error", (err) => {
      log("error", `WebSocket error: ${err.message}`);
      connectedClients = connectedClients.filter((c) => c !== client);
    });
  });

  httpServer.listen(port, "127.0.0.1", async () => {
    lockFilePath = writeLockFile(port, authToken);
    log("info", `WebSocket MCP server listening on 127.0.0.1:${port}`);
    sendToNova({
      type: "server_started",
      port,
      lockFile: lockFilePath,
      authToken,
    });

    // Conditionally start the chat module (Mode B — opt-in chat UI).
    // Wrapped in try/catch so a chat init failure never kills the MCP server.
    // Two-mode: SDK (with CHAT_API_KEY) or CLI subprocess fallback (no key —
    // uses the user's existing Claude Code OAuth session).
    if (CHAT_ENABLED) {
      try {
        const chatModule = await import("./chat-session.mjs");
        chatHandle = await chatModule.init({
          port: CHAT_PORT,
          token: CHAT_TOKEN,
          apiKey: CHAT_API_KEY || null,
          model: CHAT_MODEL,
          cliPermissionMode: process.env.CC_CHAT_CLI_PERMISSION_MODE || "acceptEdits",
          claudePath: process.env.CC_CLAUDE_PATH || "claude",
          callNovaTool,
          getBridgeInfo: () => ({
            port: serverPort,
            clientCount: connectedClients.length,
          }),
          log,
        });
        log("info", `Chat server listening on http://127.0.0.1:${CHAT_PORT}/`);

        // Mount the embedded terminal panel on the same HTTP server.
        // Lives at /cli (WebSocket only). Each connection spawns
        // `claude` in a real PTY via node-pty.
        try {
          const cliModule = await import("./cli-session.mjs");
          cliHandle = cliModule.attach({
            httpServer: chatHandle.httpServer,
            port: CHAT_PORT,
            token: CHAT_TOKEN,
            claudeCommand: process.env.CC_CLAUDE_PATH || "claude",
            claudeArgs: process.env.CC_CLAUDE_ARGS || "",
            getBridgeInfo: () => ({ port: serverPort, clientCount: connectedClients.length }),
            log,
          });
          log("info", "CLI terminal panel attached at /cli");
        } catch (err) {
          log("error", `Failed to attach CLI terminal panel: ${err.message}`);
        }

        sendToNova({ type: "chat_started", port: CHAT_PORT, token: CHAT_TOKEN });
      } catch (err) {
        log("error", `Failed to start chat server: ${err.message}`);
        sendToNova({ type: "chat_failed", message: err.message });
      }
    }
  });

  // Cleanup on exit — shared with the lost-parent paths (see shutdown()).
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("exit", () => { if (serverPort) removeLockFile(serverPort); });
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
startServer().catch((err) => {
  log("error", `Failed to start server: ${err.message}`);
  process.exit(1);
});
