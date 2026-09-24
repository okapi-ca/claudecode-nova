#!/usr/bin/env node
/**
 * End-to-end smoke test for the streaming-input chat driver (v0.25.0).
 *
 * Spawns ws-server.js with the chat enabled in OAuth mode (no API key —
 * uses the developer's own Claude Code login), connects a WebSocket client
 * with the token, and drives one persistent session through:
 *   1. a first turn                      → session_started, assistant_text, result
 *   2. a follow-up that needs context    → same session id, correct recall
 *   3. a file write under permissionMode "default" → permission_request,
 *      answered "deny"                   → tool_result isError, file absent
 *   4. a long turn interrupted via abort → result with error "Interrupted"
 *
 * LOCAL ONLY: talks to Anthropic through the developer's subscription and
 * needs Scripts/node_modules. Not wired into CI.
 */
"use strict";
const { spawn } = require("child_process");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");

const SCRIPTS = path.resolve(__dirname, "..", "claudecode-nova.novaextension", "Scripts");
const WebSocket = require(path.join(SCRIPTS, "node_modules", "ws"));
const TOKEN = "turn-test-token-0123456789abcdef";
const PROBE_FILE = path.join(os.tmpdir(), `cc-nova-turn-test-${process.pid}.txt`);

function fail(msg) { console.error("FAIL: " + msg); process.exit(1); }
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer(); srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

async function startServer(chatPort) {
  const tmpConfig = fs.mkdtempSync(path.join(os.tmpdir(), "cc-nova-turn-"));
  // No CLAUDE_CONFIG_DIR override here (unlike handshake.test.js): the
  // spawned claude must see the developer's real login. The bridge's lock
  // file therefore lands in the real ~/.claude/ide and is removed on exit.
  const env = { ...process.env, CC_PORT_MIN: "20000", CC_PORT_MAX: "30000", CC_WORKSPACE: os.tmpdir(),
    CC_CHAT_ENABLED: "1", CC_CHAT_PORT: String(chatPort), CC_CHAT_TOKEN: TOKEN,
    CC_CHAT_MODEL: "claude-haiku-4-5", CC_CHAT_CLI_PERMISSION_MODE: "default", CC_CLAUDE_PATH: "claude" };
  delete env.ANTHROPIC_API_KEY; delete env.CLAUDECODE; delete env.CLAUDE_CODE_ENTRYPOINT;
  const proc = spawn(process.execPath, [path.join(SCRIPTS, "ws-server.js")], { env, stdio: ["pipe", "pipe", "inherit"] });
  proc._tmpConfig = tmpConfig;
  proc.logs = [];
  return new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => { proc.kill(); reject(new Error("no chat_started in 20s")); }, 20000);
    proc.stdout.on("data", (chunk) => {
      buf += chunk.toString("utf8"); let i;
      while ((i = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (!line) continue;
        let msg; try { msg = JSON.parse(line); } catch { continue; }
        if (msg.type === "log") proc.logs.push(`${msg.level}: ${msg.message}`);
        if (msg.type === "chat_failed") { clearTimeout(timer); reject(new Error("chat_failed: " + msg.message)); }
        if (msg.type === "chat_started") { clearTimeout(timer); resolve(proc); }
      }
    });
    proc.on("exit", (code) => { clearTimeout(timer); reject(new Error("ws-server exited early: " + code)); });
  });
}

// Tiny event-collecting client: `next(pred, timeout)` resolves with the first
// message matching pred (buffered messages are checked first).
function client(url) {
  const ws = new WebSocket(url, { headers: { origin: url.replace(/^ws/, "http").replace(/\/ws.*$/, "") } });
  const inbox = []; const waiters = [];
  ws.on("message", (d) => {
    const msg = JSON.parse(d.toString("utf8"));
    const w = waiters.findIndex((x) => x.pred(msg));
    if (w >= 0) { const [x] = waiters.splice(w, 1); x.resolve(msg); } else inbox.push(msg);
  });
  return {
    ws, inbox,
    open: () => new Promise((res, rej) => { ws.on("open", res); ws.on("error", rej); }),
    send: (m) => ws.send(JSON.stringify(m)),
    next(pred, ms = 90000) {
      const i = inbox.findIndex(pred);
      if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0]);
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => { const k = waiters.findIndex((x) => x.resolve === resolve); if (k >= 0) waiters.splice(k, 1); reject(new Error("timeout waiting for message")); }, ms);
        waiters.push({ pred, resolve: (m) => { clearTimeout(t); resolve(m); } });
      });
    },
    drainText() { let t = ""; for (const m of inbox.splice(0)) if (m.type === "assistant_text") t += m.chunk; return t; },
  };
}

async function main() {
  const chatPort = await freePort();
  const proc = await startServer(chatPort);
  const c = client(`ws://127.0.0.1:${chatPort}/ws?token=${TOKEN}`);
  let passed = 0;
  const check = (name, cond, detail) => { if (!cond) { console.error("server logs:\n  " + proc.logs.slice(-15).join("\n  ")); fail(name + (detail !== undefined ? " — " + JSON.stringify(detail).slice(0, 300) : "")); } passed++; console.log("ok  " + name); };
  try {
    await c.open();
    const cfg = await c.next((m) => m.type === "config", 5000);
    check("config announces oauth mode + permissionMode default", cfg.mode === "oauth" && cfg.permissionMode === "default", cfg);

    // 1. first turn
    const t0 = Date.now();
    c.send({ type: "user_message", text: "Reply with exactly the word PONG and nothing else." });
    const started = await c.next((m) => m.type === "session_started");
    check("session_started (oauth)", started.mode === "oauth" && typeof started.sessionId === "string", started);
    let res = await c.next((m) => m.type === "result");
    let text = c.drainText();
    check("turn 1 succeeded with streamed text", res.success && /PONG/i.test(text), { res, text, ms: Date.now() - t0 });

    // 2. follow-up — same process, must remember
    const t1 = Date.now();
    c.send({ type: "user_message", text: "Which single word did you just reply with? Answer with that word only." });
    const started2 = await c.next((m) => m.type === "session_started");
    res = await c.next((m) => m.type === "result");
    text = c.drainText();
    check("turn 2 kept the session id", started2.sessionId === started.sessionId, { a: started.sessionId, b: started2.sessionId });
    check("turn 2 recalled context (PONG) without cold start", res.success && /PONG/i.test(text), { text, ms: Date.now() - t1 });

    // 3. permission prompt → deny
    c.send({ type: "user_message", text: `Use the Write tool to create the file ${PROBE_FILE} containing the word hello. Then say done.` });
    const perm = await c.next((m) => m.type === "permission_request");
    check("permission_request for Write with the target path", perm.toolName === "Write" && perm.input && perm.input.file_path === PROBE_FILE && perm.canAlwaysAllow === true, perm);
    c.send({ type: "permission_response", id: perm.id, behavior: "deny", message: "Denied by test" });
    const tr = await c.next((m) => m.type === "tool_result");
    check("denied tool_result is an error carrying our message", tr.isError === true && /Denied by test/.test(tr.text), tr);
    res = await c.next((m) => m.type === "result");
    c.drainText();
    check("turn 3 completed and the file was NOT written", res.success && !fs.existsSync(PROBE_FILE), { res, exists: fs.existsSync(PROBE_FILE) });

    // 4. interrupt a long turn
    c.send({ type: "user_message", text: "Count slowly from 1 to 300, one number per line, no other text." });
    await c.next((m) => m.type === "assistant_text");
    c.send({ type: "abort" });
    res = await c.next((m) => m.type === "result", 30000);
    c.drainText();
    check("abort interrupts the turn (result error = Interrupted)", res.success === false && res.error === "Interrupted", res);

    // 5. session still alive after interrupt
    c.send({ type: "user_message", text: "Reply with exactly the word ALIVE." });
    res = await c.next((m) => m.type === "result");
    text = c.drainText();
    check("session survives the interrupt", res.success && /ALIVE/i.test(text), text);

    console.log(`PASS: chat-turn — ${passed} checks`);
  } finally {
    try { c.ws.terminate(); } catch (_) {}
    proc.kill();
    try { fs.rmSync(proc._tmpConfig, { recursive: true, force: true }); } catch (_) {}
    try { fs.rmSync(PROBE_FILE, { force: true }); } catch (_) {}
  }
}
main().catch((err) => { console.error("ERROR: " + err.message); process.exit(1); });
