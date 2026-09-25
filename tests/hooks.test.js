#!/usr/bin/env node
/**
 * Hook relay test — the path Claude Code's hooks take into Nova.
 *
 * Spawns ws-server.js with a scratch CLAUDE_CONFIG_DIR, then checks:
 *   1. POST /hook without the auth token is rejected (401) and nothing is
 *      forwarded to Nova.
 *   2. POST /hook with `Authorization: Bearer <authToken>` yields a
 *      `hook_event` line on stdout carrying the event untouched.
 *   3. Scripts/hook-relay.sh, fed a hook payload on stdin, finds the lock
 *      file the server wrote, matches the payload's cwd against the lock's
 *      workspaceFolders, and delivers the event — and delivers nothing when
 *      the cwd is outside the workspace.
 *
 * Runs with `node --test tests/hooks.test.js` (or directly).
 */

"use strict";
const { spawn, spawnSync } = require("child_process");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

const SERVER_TIMEOUT_MS = 5000;
const EVENT_TIMEOUT_MS = 3000;
const NO_EVENT_WINDOW_MS = 700;

const EXT = path.resolve(__dirname, "..", "claudecode-nova.novaextension", "Scripts");
const WS_SERVER = path.join(EXT, "ws-server.js");
const RELAY = path.join(EXT, "hook-relay.sh");

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}

function startServer(workspace, tmpConfig) {
  const proc = spawn(process.execPath, [WS_SERVER], {
    env: {
      PATH: process.env.PATH,
      CC_PORT_MIN: "20000",
      CC_PORT_MAX: "30000",
      CC_WORKSPACE: workspace,
      CLAUDE_CONFIG_DIR: tmpConfig,
    },
    stdio: ["pipe", "pipe", "inherit"],
  });

  const listeners = [];
  let buf = "";
  proc.stdout.on("data", (chunk) => {
    buf += chunk.toString("utf8");
    let i;
    while ((i = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      for (const l of listeners.slice()) l(msg);
    }
  });
  proc.onMessage = (fn) => { listeners.push(fn); return () => { const k = listeners.indexOf(fn); if (k >= 0) listeners.splice(k, 1); }; };

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { proc.kill(); reject(new Error("no server_started within " + SERVER_TIMEOUT_MS + "ms")); }, SERVER_TIMEOUT_MS);
    const off = proc.onMessage((msg) => {
      if (msg.type === "server_started") {
        clearTimeout(timer); off();
        resolve({ proc, port: msg.port, authToken: msg.authToken });
      }
    });
    proc.on("error", reject);
    proc.on("exit", (code) => { clearTimeout(timer); reject(new Error("ws-server exited early: " + code)); });
  });
}

function waitForHookEvent(proc, timeoutMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => { off(); resolve(null); }, timeoutMs);
    const off = proc.onMessage((msg) => {
      if (msg.type === "hook_event") { clearTimeout(timer); off(); resolve(msg); }
    });
  });
}

function post(port, body, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1", port, method: "POST", path: "/hook",
      headers: Object.assign({ "Content-Type": "application/json" }, headers || {}),
    }, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode)); });
    req.on("error", reject);
    req.end(body);
  });
}

function runRelay(payload, tmpConfig) {
  const r = spawnSync("/bin/sh", [RELAY], {
    input: payload,
    env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: os.homedir(), CLAUDE_CONFIG_DIR: tmpConfig },
    encoding: "utf8",
    timeout: 5000,
  });
  if (r.status !== 0) fail("hook-relay.sh exited " + r.status + ": " + (r.stderr || ""));
}

async function main() {
  const tmpConfig = fs.mkdtempSync(path.join(os.tmpdir(), "cc-nova-hooks-"));
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "cc-nova-ws-"));
  const { proc, port, authToken } = await startServer(workspace, tmpConfig);

  try {
    const event = {
      session_id: "sess-test-1234",
      hook_event_name: "PreToolUse",
      cwd: workspace,
      tool_name: "Bash",
      tool_input: { command: "npm test" },
    };
    const body = JSON.stringify(event);

    // 1. Unauthenticated → 401, nothing forwarded.
    const pending1 = waitForHookEvent(proc, NO_EVENT_WINDOW_MS);
    const st1 = await post(port, body, {});
    if (st1 !== 401) fail("expected 401 without token, got " + st1);
    if (await pending1) fail("unauthenticated POST was forwarded to Nova");
    console.log("PASS: POST /hook without token → 401, not forwarded");

    // 2. Authenticated → 204 + hook_event on stdout.
    const pending2 = waitForHookEvent(proc, EVENT_TIMEOUT_MS);
    const st2 = await post(port, body, { Authorization: "Bearer " + authToken });
    if (st2 !== 204) fail("expected 204 with token, got " + st2);
    const got = await pending2;
    if (!got) fail("no hook_event forwarded after authenticated POST");
    if (got.event.session_id !== event.session_id || got.event.tool_name !== "Bash") fail("forwarded event does not match: " + JSON.stringify(got.event));
    if (got.fromChat !== false) fail("fromChat should be false without a chat session");
    console.log("PASS: POST /hook with token → 204, hook_event forwarded intact");

    // 3a. Relay script with cwd inside the workspace (a subdirectory).
    const lockFiles = fs.readdirSync(path.join(tmpConfig, "ide")).filter((f) => f.endsWith(".lock"));
    if (lockFiles.length !== 1) fail("expected exactly one lock file, found " + lockFiles.join(","));
    const relayEvent = Object.assign({}, event, { session_id: "sess-relay-5678", hook_event_name: "Stop", cwd: path.join(workspace, "sub", "dir") });
    const pending3 = waitForHookEvent(proc, EVENT_TIMEOUT_MS);
    runRelay(JSON.stringify(relayEvent), tmpConfig);
    const got3 = await pending3;
    if (!got3) fail("hook-relay.sh did not deliver the event for a cwd inside the workspace");
    if (got3.event.session_id !== "sess-relay-5678" || got3.event.hook_event_name !== "Stop") fail("relayed event mismatch: " + JSON.stringify(got3.event));
    console.log("PASS: hook-relay.sh delivered the event via the lock file (cwd inside workspace)");

    // 3b. Relay script with cwd outside the workspace → nothing delivered.
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "cc-nova-elsewhere-"));
    const pending4 = waitForHookEvent(proc, NO_EVENT_WINDOW_MS);
    runRelay(JSON.stringify(Object.assign({}, event, { cwd: outside })), tmpConfig);
    if (await pending4) fail("hook-relay.sh delivered an event whose cwd is outside the workspace");
    console.log("PASS: hook-relay.sh ignored an event from another workspace");

    console.log("PASS: hook relay end-to-end");
  } finally {
    proc.kill("SIGTERM");
    await new Promise((r) => proc.on("exit", r));
  }
}

main().catch((err) => fail(err.message));
