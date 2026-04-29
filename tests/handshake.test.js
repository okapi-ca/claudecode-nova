#!/usr/bin/env node
/**
 * Regression test for the WebSocket handshake.
 *
 * v0.1.0 shipped with a transposed RFC 6455 GUID in ws-server.js, which
 * caused every RFC-compliant client (Claude CLI v2.1.x, the `ws` Node
 * library, etc.) to close the connection with ECONNRESET ~5 ms after
 * the 101 Switching Protocols. This test spawns ws-server.js, completes
 * a handshake using the RFC GUID, and verifies the server-returned
 * Sec-WebSocket-Accept matches the client's independently-computed
 * digest. If they diverge, the GUID has been corrupted again.
 */

"use strict";
const { spawn } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");

const RFC6455_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const SERVER_TIMEOUT_MS = 5000;
const HANDSHAKE_TIMEOUT_MS = 3000;

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}

async function startServer() {
  const tmpConfig = fs.mkdtempSync(path.join(os.tmpdir(), "cc-nova-test-"));
  const wsServer = path.resolve(__dirname, "..",
    "claudecode-nova.novaextension", "Scripts", "ws-server.js");

  const proc = spawn(process.execPath, [wsServer], {
    env: {
      PATH: process.env.PATH,
      CC_PORT_MIN: "20000",
      CC_PORT_MAX: "30000",
      CC_WORKSPACE: process.cwd(),
      CLAUDE_CONFIG_DIR: tmpConfig,
    },
    stdio: ["pipe", "pipe", "inherit"],
  });

  proc._tmpConfig = tmpConfig;

  return new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error("ws-server did not emit server_started within " + SERVER_TIMEOUT_MS + "ms"));
    }, SERVER_TIMEOUT_MS);

    proc.stdout.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      let i;
      while ((i = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.type === "server_started") {
            clearTimeout(timer);
            resolve({ proc, port: msg.port, authToken: msg.authToken });
            return;
          }
        } catch { /* not JSON, ignore */ }
      }
    });

    proc.on("error", reject);
    proc.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error("ws-server exited prematurely with code " + code));
    });
  });
}

function handshake(port, authToken) {
  const key = crypto.randomBytes(16).toString("base64");
  const expectedAccept = crypto
    .createHash("sha1")
    .update(key + RFC6455_GUID)
    .digest("base64");

  return new Promise((resolve, reject) => {
    const sock = net.connect(port, "127.0.0.1");
    let buf = "";
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error("handshake timeout"));
    }, HANDSHAKE_TIMEOUT_MS);

    sock.on("connect", () => {
      sock.write(
        "GET / HTTP/1.1\r\n" +
        "Host: 127.0.0.1:" + port + "\r\n" +
        "Connection: Upgrade\r\n" +
        "Upgrade: websocket\r\n" +
        "Sec-WebSocket-Version: 13\r\n" +
        "Sec-WebSocket-Key: " + key + "\r\n" +
        "Sec-WebSocket-Protocol: mcp\r\n" +
        "x-claude-code-ide-authorization: " + authToken + "\r\n\r\n"
      );
    });

    sock.on("data", (data) => {
      buf += data.toString("utf8");
      const idx = buf.indexOf("\r\n\r\n");
      if (idx < 0) return;
      // Include the trailing \r\n of the last header so per-header regexes
      // anchored on \r still match the final line.
      const headers = buf.slice(0, idx + 2);
      clearTimeout(timer);
      sock.destroy();

      if (!headers.startsWith("HTTP/1.1 101")) {
        return reject(new Error("expected 101, got: " + headers.split("\r\n")[0]));
      }
      const accept = headers.match(/Sec-WebSocket-Accept:\s*(.+?)\r\n/i);
      if (!accept) {
        return reject(new Error("server response missing Sec-WebSocket-Accept"));
      }
      const protocol = headers.match(/Sec-WebSocket-Protocol:\s*(.+?)\r\n/i);
      resolve({
        accept: accept[1].trim(),
        expectedAccept,
        protocol: protocol ? protocol[1].trim() : null,
      });
    });

    sock.on("error", (err) => { clearTimeout(timer); reject(err); });
  });
}

async function main() {
  const { proc, port, authToken } = await startServer();
  try {
    const result = await handshake(port, authToken);

    if (result.accept !== result.expectedAccept) {
      fail("Sec-WebSocket-Accept mismatch — server returned \"" + result.accept +
           "\", expected \"" + result.expectedAccept + "\". " +
           "RFC 6455 GUID is probably corrupted in ws-server.js.");
    }
    if (result.protocol !== "mcp") {
      fail("server did not echo Sec-WebSocket-Protocol: mcp (got " +
           (result.protocol || "<none>") + "). Strict clients will reject.");
    }
    console.log("PASS: handshake matches RFC 6455 (accept=" + result.accept.slice(0, 12) + "…, subprotocol=mcp)");
  } finally {
    proc.kill();
    try { fs.rmSync(proc._tmpConfig, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

main().catch((err) => {
  console.error("ERROR: " + err.message);
  process.exit(1);
});
