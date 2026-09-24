#!/usr/bin/env node
/**
 * Integration test — the chat (/ws) and terminal (/cli) WebSocket gates.
 *
 * Spawns ws-server.js with the chat enabled (CLI/OAuth mode — no API key,
 * so nothing talks to Anthropic) on a random port with a known token, then
 * exercises the Host / Origin / token checks end to end through a real
 * HTTP + WebSocket client. Also checks that an unknown upgrade path is
 * closed instead of left hanging.
 *
 * Needs claudecode-nova.novaextension/Scripts/node_modules (ws, agent SDK)
 * — run locally after `npm install` there; CI runs the dependency-free
 * unit test tests/ws-auth.test.mjs instead.
 */

"use strict";
const { spawn } = require("child_process");
const fs = require("fs");
const http = require("http");
const net = require("net");
const os = require("os");
const path = require("path");

const SCRIPTS = path.resolve(__dirname, "..", "claudecode-nova.novaextension", "Scripts");
const WebSocket = require(path.join(SCRIPTS, "node_modules", "ws"));

const TOKEN = "test-token-0123456789abcdef0123456789abcdef";
const START_TIMEOUT_MS = 15000;

function fail(msg) { console.error("FAIL: " + msg); process.exit(1); }

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function startServer(chatPort) {
  const tmpConfig = fs.mkdtempSync(path.join(os.tmpdir(), "cc-nova-chat-test-"));
  const proc = spawn(process.execPath, [path.join(SCRIPTS, "ws-server.js")], {
    env: {
      PATH: process.env.PATH,
      HOME: os.homedir(),
      CC_PORT_MIN: "20000",
      CC_PORT_MAX: "30000",
      CC_WORKSPACE: process.cwd(),
      CLAUDE_CONFIG_DIR: tmpConfig,
      CC_CHAT_ENABLED: "1",
      CC_CHAT_PORT: String(chatPort),
      CC_CHAT_TOKEN: TOKEN,
      CC_CLAUDE_PATH: "/usr/bin/true",   // PTY spawns exit immediately; never reaches Anthropic
    },
    stdio: ["pipe", "pipe", "inherit"],
  });
  proc._tmpConfig = tmpConfig;

  return new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => { proc.kill(); reject(new Error("no chat_started within " + START_TIMEOUT_MS + "ms")); }, START_TIMEOUT_MS);
    proc.stdout.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      let i;
      while ((i = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line) continue;
        let msg; try { msg = JSON.parse(line); } catch { continue; }
        if (msg.type === "chat_failed") { clearTimeout(timer); reject(new Error("chat_failed: " + msg.message)); }
        if (msg.type === "chat_started") { clearTimeout(timer); resolve(proc); }
      }
    });
    proc.on("exit", (code) => { clearTimeout(timer); reject(new Error("ws-server exited early: " + code)); });
  });
}

// Open a WebSocket and report how it ended: {opened:true, firstMessage} or {opened:false, status}.
function tryWs(url, headers) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, { headers, handshakeTimeout: 3000 });
    let settled = false;
    const done = (r) => { if (!settled) { settled = true; try { ws.terminate(); } catch (_) {} resolve(r); } };
    ws.on("unexpected-response", (_req, res) => done({ opened: false, status: res.statusCode }));
    ws.on("error", (err) => done({ opened: false, status: null, error: err.message }));
    ws.on("message", (data) => {
      let msg = null; try { msg = JSON.parse(data.toString("utf8")); } catch (_) {}
      done({ opened: true, firstMessage: msg });
    });
    ws.on("close", () => done({ opened: false, status: null, closed: true }));
    setTimeout(() => done({ opened: ws.readyState === WebSocket.OPEN, firstMessage: null }), 2500);
  });
}

function httpGet(port, pathname, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: pathname, method: "GET", headers }, (res) => {
      res.resume(); res.on("end", () => resolve(res.statusCode));
    });
    req.on("error", reject); req.end();
  });
}

// Raw upgrade to a path nobody owns — must get an HTTP error, not hang.
function rawUpgrade(port, pathname) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, "127.0.0.1");
    let buf = "";
    const timer = setTimeout(() => { sock.destroy(); reject(new Error("unknown-path upgrade hung (no response in 3s)")); }, 3000);
    sock.on("connect", () => sock.write(
      "GET " + pathname + " HTTP/1.1\r\nHost: 127.0.0.1:" + port + "\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n" +
      "Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n"));
    sock.on("data", (d) => { buf += d.toString(); if (buf.includes("\r\n\r\n")) { clearTimeout(timer); sock.destroy(); resolve(buf.split("\r\n")[0]); } });
    sock.on("error", (e) => { clearTimeout(timer); reject(e); });
  });
}

async function main() {
  const chatPort = await freePort();
  const proc = await startServer(chatPort);
  const base = `ws://127.0.0.1:${chatPort}`;
  const ownOrigin = `http://127.0.0.1:${chatPort}`;
  let passed = 0;
  const check = (name, cond, detail) => { if (!cond) fail(name + (detail ? " — " + JSON.stringify(detail) : "")); passed++; };

  try {
    // Static page: no token needed, but foreign Host is refused.
    check("GET / serves the page", await httpGet(chatPort, "/") === 200);
    check("GET / with foreign Host → 403", await httpGet(chatPort, "/", { host: "evil.example:" + chatPort }) === 403);

    // /ws
    let r = await tryWs(`${base}/ws?token=${TOKEN}`, { origin: ownOrigin });
    check("/ws same-origin + token → opens and receives config", r.opened && r.firstMessage && r.firstMessage.type === "config", r);
    r = await tryWs(`${base}/ws`, { origin: ownOrigin });
    check("/ws without token → 401", !r.opened && r.status === 401, r);
    r = await tryWs(`${base}/ws?token=${TOKEN}`, { origin: "https://evil.example" });
    check("/ws foreign Origin → 403", !r.opened && r.status === 403, r);
    r = await tryWs(`${base}/ws?token=${TOKEN.slice(0, -1)}x`, { origin: ownOrigin });
    check("/ws wrong token → 401", !r.opened && r.status === 401, r);

    // /cli — the PTY endpoint
    r = await tryWs(`${base}/cli`, { origin: ownOrigin });
    check("/cli without token → 401", !r.opened && r.status === 401, r);
    r = await tryWs(`${base}/cli?token=${TOKEN}`, { origin: "https://evil.example" });
    check("/cli foreign Origin → 403", !r.opened && r.status === 403, r);
    r = await tryWs(`${base}/cli?token=${TOKEN}`, { origin: ownOrigin });
    check("/cli same-origin + token → accepted (PTY ran /usr/bin/true)", r.opened || (r.firstMessage && r.firstMessage.type), r);

    // Unknown upgrade path is closed, not left hanging.
    const status = await rawUpgrade(chatPort, "/nope");
    check("unknown upgrade path → HTTP 404, socket closed", /^HTTP\/1\.1 404/.test(status), status);

    console.log(`PASS: chat-auth — ${passed} checks on port ${chatPort}`);
  } finally {
    proc.kill();
    try { fs.rmSync(proc._tmpConfig, { recursive: true, force: true }); } catch (_) {}
  }
}

main().catch((err) => { console.error("ERROR: " + err.message); process.exit(1); });
