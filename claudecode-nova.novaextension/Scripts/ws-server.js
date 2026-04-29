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

// Register the 10 MCP tools that Claude Code expects (matching VS Code / Neovim)
registerTool("openFile", {
  type: "object",
  properties: {
    filePath:  { type: "string", description: "Absolute path of the file to open" },
    lineNumber: { type: "number", description: "Line number to scroll to" },
    selectText: { type: "string", description: "Text to select after opening" },
  },
  required: ["filePath"],
}, "Open a file in the IDE");

registerTool("openDiff", {
  type: "object",
  properties: {
    filePath: { type: "string", description: "Absolute file path" },
    oldContent: { type: "string", description: "Original file content" },
    newContent: { type: "string", description: "Proposed new content" },
    tabName:   { type: "string", description: "Tab label for the diff view" },
  },
  required: ["filePath", "oldContent", "newContent"],
}, "Open a diff view for proposed changes");

registerTool("getCurrentSelection", {
  type: "object", properties: {},
}, "Get the current editor selection");

registerTool("getLatestSelection", {
  type: "object", properties: {},
}, "Get the most recent editor selection");

registerTool("getOpenEditors", {
  type: "object", properties: {},
}, "List all open editor tabs");

registerTool("getWorkspaceFolders", {
  type: "object", properties: {},
}, "Get workspace folder paths");

registerTool("checkDocumentDirty", {
  type: "object",
  properties: {
    filePath: { type: "string", description: "File path to check" },
  },
  required: ["filePath"],
}, "Check if a document has unsaved changes");

registerTool("saveDocument", {
  type: "object",
  properties: {
    filePath: { type: "string", description: "File path to save" },
  },
  required: ["filePath"],
}, "Save a document");

registerTool("getDiagnostics", {
  type: "object",
  properties: {
    filePath: { type: "string", description: "File path to get diagnostics for" },
  },
}, "Get LSP diagnostics / issues for a file");

registerTool("closeAllDiffTabs", {
  type: "object", properties: {},
}, "Clean up temporary diff files staged for review (Nova does not expose a tab-close API; this removes the proposed_* files in extension storage)");

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
        serverInfo: { name: "nova-claudecode-bridge", version: "0.2.0" },
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

    // Forward to Nova extension and wait for response
    const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    
    sendToNova({
      type: "tool_call",
      requestId,
      tool: toolName,
      arguments: toolArgs,
      mcpId: id,
    });

    // Store pending — Nova will respond with tool_result
    pendingRequests[requestId] = {
      client,
      mcpId: id,
      timeout: setTimeout(() => {
        delete pendingRequests[requestId];
        sendWSMessage(client, {
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "text", text: JSON.stringify({ error: "Tool call timed out" }) }],
          },
        });
      }, 30000),
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
    sendToNova({ type: "client_connected" });
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

function handleNovaMessage(msg) {
  // Tool result from Nova
  if (msg.type === "tool_result" && msg.requestId) {
    const pending = pendingRequests[msg.requestId];
    if (pending) {
      clearTimeout(pending.timeout);
      delete pendingRequests[msg.requestId];
      
      sendWSMessage(pending.client, {
        jsonrpc: "2.0",
        id: pending.mcpId,
        result: {
          content: [{ type: "text", text: JSON.stringify(msg.result) }],
        },
      });
    }
    return;
  }

  // Selection update broadcast
  if (msg.type === "selection_update") {
    broadcastNotification("notifications/selectionChanged", msg.data);
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
      const payload = { result: resultText };
      // Surface user edits made in the proposed-changes tab before Accept.
      // Lets Claude reconcile its plan with what was actually written to disk
      // (mirrors the v2.1.110 Write+IDE diff awareness behaviour).
      if (msg.userEdited) {
        payload.userEdited = true;
        if (msg.finalContent !== undefined) {
          payload.finalContent = msg.finalContent;
        }
      }
      sendWSMessage(pending.client, {
        jsonrpc: "2.0",
        id: pending.mcpId,
        result: {
          content: [{ type: "text", text: JSON.stringify(payload) }],
        },
      });
    }
    return;
  }
}

// ---------------------------------------------------------------------------
// WebSocket upgrade & HTTP server
// ---------------------------------------------------------------------------
let serverPort = null;
let lockFilePath = null;
let authToken = null;

async function startServer() {
  authToken = generateAuthToken();

  const port = await findPort(PORT_MIN, PORT_MAX);
  serverPort = port;

  const httpServer = http.createServer((req, res) => {
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
    });

    socket.on("error", (err) => {
      log("error", `WebSocket error: ${err.message}`);
      connectedClients = connectedClients.filter((c) => c !== client);
    });
  });

  httpServer.listen(port, "127.0.0.1", () => {
    lockFilePath = writeLockFile(port, authToken);
    log("info", `WebSocket MCP server listening on 127.0.0.1:${port}`);
    sendToNova({
      type: "server_started",
      port,
      lockFile: lockFilePath,
      authToken,
    });
  });

  // Cleanup on exit
  function cleanup() {
    if (serverPort) removeLockFile(serverPort);
    for (const client of connectedClients) {
      try { client.socket.destroy(); } catch (_) {}
    }
    process.exit(0);
  }

  process.on("SIGTERM", cleanup);
  process.on("SIGINT", cleanup);
  process.on("exit", () => { if (serverPort) removeLockFile(serverPort); });
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
startServer().catch((err) => {
  log("error", `Failed to start server: ${err.message}`);
  process.exit(1);
});
