#!/usr/bin/env node
/**
 * Direct CLI client for the Claude Code ↔ Nova bridge.
 *
 * The Claude Code CLI only forwards `mcp__ide__getDiagnostics` to the model,
 * so the other 11 MCP tools registered by ws-server.js (getOpenEditors,
 * getCurrentSelection, openFile, openDiff, …) are unreachable from a model
 * conversation. This script connects to the bridge directly via the lock
 * file under `~/.claude/ide/<port>.lock` and invokes any tool by name.
 *
 *   node call-bridge.js                        # show usage
 *   node call-bridge.js getOpenEditors         # call with empty args
 *   node call-bridge.js openFile '{"filePath":"/abs/path"}'
 *
 * No npm dependencies — manual WebSocket framing mirrors ws-server.js.
 */

const crypto = require("crypto");
const net = require("net");
const fs = require("fs");
const path = require("path");
const os = require("os");

const RFC6455_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const TIMEOUT_MS = 10000;

const TOOLS = [
  "openFile",
  "openDiff",
  "getCurrentSelection",
  "getLatestSelection",
  "getOpenEditors",
  "getWorkspaceFolders",
  "checkDocumentDirty",
  "saveDocument",
  "getDiagnostics",
  "close_tab",
  "closeAllDiffTabs",
  "executeCode",
];

function usage() {
  process.stderr.write(
    "Usage: node call-bridge.js <tool> [args-json]\n" +
    "       node call-bridge.js --tools         # list tools available on the bridge\n\n" +
    "Tools registered by ws-server.js:\n  " + TOOLS.join("\n  ") + "\n\n" +
    "Examples:\n" +
    "  node call-bridge.js getOpenEditors\n" +
    "  node call-bridge.js getCurrentSelection\n" +
    "  node call-bridge.js openFile '{\"filePath\":\"/abs/path\",\"makeFrontmost\":false}'\n" +
    "  node call-bridge.js openDiff '{\"old_file_path\":\"/abs/a\",\"new_file_path\":\"/abs/a\",\"new_file_contents\":\"...\",\"tab_name\":\"proposed\"}'\n" +
    "  node call-bridge.js getDiagnostics '{\"uri\":\"file:///abs/path\"}'\n"
  );
}

function findLockFile() {
  const dir = path.join(
    process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"),
    "ide"
  );
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".lock"));
  if (files.length === 0) {
    throw new Error("No Claude Code IDE lock file found in " + dir);
  }
  const cwd = process.cwd();
  // Prefer a lock whose workspace contains the current cwd
  for (const f of files) {
    const lock = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
    if ((lock.workspaceFolders || []).some((w) => cwd.startsWith(w))) {
      return { ...lock, port: parseInt(f.replace(".lock", ""), 10) };
    }
  }
  const lock = JSON.parse(fs.readFileSync(path.join(dir, files[0]), "utf8"));
  return { ...lock, port: parseInt(files[0].replace(".lock", ""), 10) };
}

function makeFrame(text) {
  const payload = Buffer.from(text, "utf8");
  const len = payload.length;
  const mask = crypto.randomBytes(4);
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = 0x80 | len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 0x80 | 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x81;
  const masked = Buffer.alloc(len);
  for (let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i % 4];
  return Buffer.concat([header, mask, masked]);
}

function parseFrame(buf) {
  if (buf.length < 2) return null;
  const opcode = buf[0] & 0x0f;
  if (buf[1] & 0x80) {
    throw new Error("Server sent a masked frame (RFC 6455 violation)");
  }
  let len = buf[1] & 0x7f;
  let off = 2;
  if (len === 126) {
    if (buf.length < 4) return null;
    len = buf.readUInt16BE(2);
    off = 4;
  } else if (len === 127) {
    if (buf.length < 10) return null;
    len = Number(buf.readBigUInt64BE(2));
    off = 10;
  }
  if (buf.length < off + len) return null;
  return { opcode, payload: buf.slice(off, off + len), total: off + len };
}

function rpc(method, params) {
  const lock = findLockFile();
  const key = crypto.randomBytes(16).toString("base64");
  const expectedAccept = crypto
    .createHash("sha1")
    .update(key + RFC6455_GUID)
    .digest("base64");

  return new Promise((resolve, reject) => {
    const sock = net.connect(lock.port, "127.0.0.1");
    let phase = "handshake";
    let buf = Buffer.alloc(0);

    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error("Bridge call timed out after " + TIMEOUT_MS + "ms"));
    }, TIMEOUT_MS);

    sock.on("connect", () => {
      sock.write(
        "GET / HTTP/1.1\r\n" +
        "Host: 127.0.0.1:" + lock.port + "\r\n" +
        "Connection: Upgrade\r\n" +
        "Upgrade: websocket\r\n" +
        "Sec-WebSocket-Version: 13\r\n" +
        "Sec-WebSocket-Key: " + key + "\r\n" +
        "Sec-WebSocket-Protocol: mcp\r\n" +
        "x-claude-code-ide-authorization: " + lock.authToken + "\r\n\r\n"
      );
    });

    sock.on("data", (data) => {
      buf = Buffer.concat([buf, data]);

      if (phase === "handshake") {
        const idx = buf.indexOf("\r\n\r\n");
        if (idx < 0) return;
        const headers = buf.slice(0, idx).toString("utf8");
        buf = buf.slice(idx + 4);

        if (!headers.startsWith("HTTP/1.1 101")) {
          clearTimeout(timer);
          sock.destroy();
          return reject(new Error("Bridge handshake failed: " + headers.split("\r\n")[0]));
        }
        const m = headers.match(/Sec-WebSocket-Accept:\s*(.+?)\r/i);
        if (!m || m[1].trim() !== expectedAccept) {
          clearTimeout(timer);
          sock.destroy();
          return reject(new Error("Invalid Sec-WebSocket-Accept (bridge GUID mismatch?)"));
        }
        phase = "ws";

        sock.write(makeFrame(JSON.stringify({
          jsonrpc: "2.0", id: 1, method: "initialize",
          params: {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "call-bridge", version: "1.0" },
          },
        })));
      }

      let frame;
      try { frame = parseFrame(buf); } catch (err) { clearTimeout(timer); sock.destroy(); return reject(err); }
      while (frame) {
        buf = buf.slice(frame.total);
        if (frame.opcode === 0x01) {
          const msg = JSON.parse(frame.payload.toString("utf8"));
          if (msg.id === 1) {
            sock.write(makeFrame(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })));
            sock.write(makeFrame(JSON.stringify({ jsonrpc: "2.0", id: 2, method, params })));
          } else if (msg.id === 2) {
            clearTimeout(timer);
            sock.destroy();
            if (msg.error) return reject(new Error(msg.error.message));
            return resolve(msg.result);
          }
        }
        try { frame = parseFrame(buf); } catch (err) { clearTimeout(timer); sock.destroy(); return reject(err); }
      }
    });

    sock.on("error", (err) => { clearTimeout(timer); reject(err); });
  });
}

function unwrapToolResult(result) {
  // tools/call wraps output in { content: [{ type: "text", text: "<json>" }] }
  if (result && Array.isArray(result.content) && result.content[0]?.type === "text") {
    const text = result.content[0].text;
    try { return JSON.parse(text); } catch { return text; }
  }
  return result;
}

async function main() {
  const [, , tool, argsJson] = process.argv;

  if (!tool || tool === "--help" || tool === "-h") {
    usage();
    process.exit(tool ? 0 : 2);
  }

  if (tool === "--tools") {
    const result = await rpc("tools/list", {});
    console.log(JSON.stringify(result.tools.map((t) => t.name), null, 2));
    return;
  }

  let args = {};
  if (argsJson) {
    try { args = JSON.parse(argsJson); }
    catch (err) {
      process.stderr.write("Invalid args JSON: " + err.message + "\n");
      process.exit(2);
    }
  }

  const result = await rpc("tools/call", { name: tool, arguments: args });
  console.log(JSON.stringify(unwrapToolResult(result), null, 2));
}

main().catch((err) => {
  process.stderr.write("Error: " + err.message + "\n");
  process.exit(1);
});
