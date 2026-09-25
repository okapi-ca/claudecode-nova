#!/usr/bin/env node
/**
 * diagnostics.js — the project-linter fallback behind getDiagnostics.
 *
 * Hermetic: builds a scratch workspace with FAKE linters (shell scripts under
 * node_modules/.bin and .venv/bin that print canned tsc / eslint / ruff
 * output) and checks that:
 *   - runners are detected from their config markers + binaries
 *   - tsc text, ESLint JSON and Ruff JSON are parsed into the protocol shape
 *     (0-based positions, severity names, source, file:// URIs)
 *   - a uri argument scopes the result to that file (tsc filtered, others
 *     passed the target)
 *   - a runner that exceeds the deadline is reported as `timeout`, and a
 *     runner whose binary is missing as `skipped` with a reason
 *   - a repeat call within CACHE_MS is served from cache (no second run)
 *
 * Run: node tests/diagnostics.test.js
 */

"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { pathToFileURL } = require("url");

const SCRIPTS = path.resolve(__dirname, "..", "claudecode-nova.novaextension", "Scripts");
const { runDiagnostics, clearCache } = require(path.join(SCRIPTS, "diagnostics.js"));

let ok = true;
function check(cond, msg) {
  console.log((cond ? "PASS" : "FAIL") + ": " + msg);
  if (!cond) ok = false;
}

function writeExec(p, body) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
  fs.chmodSync(p, 0o755);
}

function makeWorkspace() {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "cc-diag-"));
  fs.mkdirSync(path.join(ws, "src"));
  fs.writeFileSync(path.join(ws, "src", "a.ts"), "export const a = 1;\n");
  fs.writeFileSync(path.join(ws, "src", "b.ts"), "export const b = 2;\n");
  fs.writeFileSync(path.join(ws, "app.py"), "x = 1\n");
  fs.writeFileSync(path.join(ws, "tsconfig.json"), "{}");
  fs.writeFileSync(path.join(ws, "eslint.config.js"), "module.exports = [];");
  fs.writeFileSync(path.join(ws, "pyproject.toml"), "[tool.ruff]\n");

  // Fake tsc: two errors in two files, exit 2 like the real thing. Records
  // its invocations so the cache test can count runs.
  writeExec(path.join(ws, "node_modules/.bin/tsc"), `#!/bin/sh
echo run >> "$PWD/.tsc-runs"
echo "src/a.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'."
echo "src/b.ts(10,1): error TS1005: ';' expected."
exit 2
`);
  // Fake eslint: echoes the target it was given, one warning + one error on a.ts.
  writeExec(path.join(ws, "node_modules/.bin/eslint"), `#!/bin/sh
target=""
for arg in "$@"; do target="$arg"; done
echo "$target" > "$PWD/.eslint-target"
cat <<EOF
[{"filePath":"$PWD/src/a.ts","messages":[
  {"ruleId":"no-unused-vars","severity":1,"message":"'x' is defined but never used.","line":3,"column":7,"endLine":3,"endColumn":8},
  {"ruleId":"eqeqeq","severity":2,"message":"Expected '===' and instead saw '=='.","line":5,"column":3,"endLine":5,"endColumn":5}
]}]
EOF
exit 1
`);
  // Fake ruff in the project venv.
  writeExec(path.join(ws, ".venv/bin/ruff"), `#!/bin/sh
cat <<EOF
[{"code":"F401","message":"\`os\` imported but unused","filename":"$PWD/app.py","location":{"row":1,"column":8},"end_location":{"row":1,"column":10}}]
EOF
`);
  return ws;
}

async function main() {
  const ws = makeWorkspace();
  // The module emits realpath-based URIs (macOS: /var → /private/var), so
  // build expectations from the real path too.
  const wsReal = fs.realpathSync.native(ws);
  const env = { PATH: "/usr/bin:/bin" };   // no global linters — only the fakes resolve

  // ── full run ────────────────────────────────────────────────────────────
  clearCache();
  const full = await runDiagnostics({ workspace: ws, env, timeoutMs: 5000 });
  const byName = Object.fromEntries(full.sources.map((s) => [s.name, s]));
  check(byName.typescript.status === "ok" && byName.typescript.count === 2, "tsc detected and parsed 2 errors");
  check(byName.eslint.status === "ok" && byName.eslint.count === 2, "eslint detected and parsed 2 messages");
  check(byName.ruff.status === "ok" && byName.ruff.count === 1, "ruff detected (venv) and parsed 1 finding");

  const aUri = pathToFileURL(path.join(wsReal, "src", "a.ts")).href;
  const aFile = full.files.find((f) => f.uri === aUri);
  check(!!aFile && aFile.diagnostics.length === 3, "a.ts groups tsc + eslint diagnostics under one file:// uri");
  const tsErr = aFile && aFile.diagnostics.find((d) => d.source === "typescript");
  check(tsErr && tsErr.range.start.line === 2 && tsErr.range.start.character === 6 && tsErr.severity === "Error" && tsErr.code === "TS2322",
    "tsc diagnostic: 0-based range, severity Error, code TS2322");
  const esWarn = aFile && aFile.diagnostics.find((d) => d.code === "no-unused-vars");
  check(esWarn && esWarn.severity === "Warning" && esWarn.range.end.character === 7, "eslint severity 1 → Warning, end column mapped");
  const esErr = aFile && aFile.diagnostics.find((d) => d.code === "eqeqeq");
  check(esErr && esErr.severity === "Error", "eslint severity 2 → Error");
  const pyFile = full.files.find((f) => f.uri.endsWith("/app.py"));
  check(pyFile && pyFile.diagnostics[0].source === "ruff" && pyFile.diagnostics[0].code === "F401", "ruff finding mapped with source + code");
  check(/typescript: 2 issues/.test(full.summary) && /ruff: 1 issue \(/.test(full.summary), "summary line lists per-runner counts");
  check(fs.readFileSync(path.join(ws, ".eslint-target"), "utf8").trim() === ".", "full run lints the whole project (eslint target '.')");

  // ── cache ───────────────────────────────────────────────────────────────
  const runsBefore = fs.readFileSync(path.join(ws, ".tsc-runs"), "utf8").split("\n").filter(Boolean).length;
  const again = await runDiagnostics({ workspace: ws, env, timeoutMs: 5000 });
  const runsAfter = fs.readFileSync(path.join(ws, ".tsc-runs"), "utf8").split("\n").filter(Boolean).length;
  check(again === full && runsAfter === runsBefore, "second call within CACHE_MS served from cache (tsc not re-run)");

  // ── scoped to one file ──────────────────────────────────────────────────
  clearCache();
  const scoped = await runDiagnostics({ workspace: ws, env, timeoutMs: 5000, uri: aUri });
  check(scoped.files.length === 1 && scoped.files[0].uri === aUri, "uri argument scopes the result to that file");
  check(scoped.files[0].diagnostics.every((d) => d.source !== "ruff") && scoped.files[0].diagnostics.length === 3, "tsc output filtered to the file, other files dropped");
  check(fs.realpathSync.native(fs.readFileSync(path.join(ws, ".eslint-target"), "utf8").trim()) === path.join(wsReal, "src", "a.ts"), "eslint invoked on the single target file");
  const scopedBad = await (clearCache(), runDiagnostics({ workspace: ws, env, timeoutMs: 5000, uri: pathToFileURL(path.join(ws, "src", "b.ts")).href }));
  check(scopedBad.files.length === 1 && scopedBad.files[0].diagnostics.length === 1 && scopedBad.files[0].diagnostics[0].code === "TS1005", "scoping to b.ts keeps only its tsc error");

  // ── timeout + missing binary ────────────────────────────────────────────
  writeExec(path.join(ws, "node_modules/.bin/tsc"), "#!/bin/sh\nsleep 5\n");
  fs.rmSync(path.join(ws, ".venv"), { recursive: true, force: true });
  clearCache();
  const t0 = Date.now();
  const slow = await runDiagnostics({ workspace: ws, env, timeoutMs: 600 });
  const elapsed = Date.now() - t0;
  const slowBy = Object.fromEntries(slow.sources.map((s) => [s.name, s]));
  check(slowBy.typescript.status === "timeout" && elapsed < 3000, `slow tsc reported as timeout and killed (took ${elapsed} ms, deadline 600)`);
  check(slowBy.ruff.status === "skipped" && /not found/.test(slowBy.ruff.reason), "ruff with marker but no binary → skipped with reason");
  check(slowBy.eslint.status === "ok", "the other runners still complete when one times out");
  check(/typescript: timeout/.test(slow.summary), "summary names the timeout instead of claiming zero issues");

  // ── empty workspace ─────────────────────────────────────────────────────
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "cc-diag-empty-"));
  clearCache();
  const none = await runDiagnostics({ workspace: empty, env, timeoutMs: 1000 });
  check(none.files.length === 0 && none.sources.every((s) => s.status === "skipped"), "workspace without linters → all skipped, no files");

  // ── MCP round-trip through ws-server.js ─────────────────────────────────
  // Restore a working fake tsc, then drive tools/call getDiagnostics over a
  // real WebSocket and check the wire shape + the tool_call_local notice to Nova.
  writeExec(path.join(ws, "node_modules/.bin/tsc"), `#!/bin/sh
echo "src/a.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'."
exit 2
`);
  await mcpRoundTrip(ws, wsReal);

  if (!ok) process.exit(1);
  console.log("PASS: diagnostics fallback");
}

function mcpRoundTrip(ws, wsReal) {
  const { spawn } = require("child_process");
  const WebSocket = require(path.join(SCRIPTS, "node_modules", "ws"));
  const tmpConfig = fs.mkdtempSync(path.join(os.tmpdir(), "cc-diag-cfg-"));
  const server = spawn(process.execPath, [path.join(SCRIPTS, "ws-server.js")], {
    env: { PATH: "/usr/bin:/bin", CC_PORT_MIN: "20000", CC_PORT_MAX: "30000", CC_WORKSPACE: ws, CLAUDE_CONFIG_DIR: tmpConfig, CC_DIAGNOSTICS_TIMEOUT_MS: "5000" },
    stdio: ["pipe", "pipe", "inherit"],
  });
  const novaMsgs = [];
  let buf = "";
  server.stdout.on("data", (c) => {
    buf += c.toString("utf8");
    let i;
    while ((i = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      try { novaMsgs.push(JSON.parse(line)); } catch {}
    }
  });
  return new Promise((resolve) => {
    const finish = () => { server.kill("SIGTERM"); resolve(); };
    const timer = setTimeout(() => { check(false, "MCP round-trip timed out"); finish(); }, 15000);
    const waitStarted = setInterval(() => {
      const started = novaMsgs.find((m) => m.type === "server_started");
      if (!started) return;
      clearInterval(waitStarted);
      const sock = new WebSocket(`ws://127.0.0.1:${started.port}`, ["mcp"], {
        headers: { "x-claude-code-ide-authorization": started.authToken },
      });
      sock.on("open", () => {
        sock.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "getDiagnostics", arguments: {} } }));
      });
      sock.on("message", (data) => {
        let msg; try { msg = JSON.parse(data.toString()); } catch { return; }
        if (msg.id !== 1) return;
        clearTimeout(timer);
        const content = msg.result && msg.result.content || [];
        let files = null; try { files = JSON.parse(content[0].text); } catch {}
        check(Array.isArray(files) && files.length >= 1, "MCP: first content block is the JSON diagnostics array");
        const a = files && files.find((f) => f.uri === pathToFileURL(path.join(wsReal, "src", "a.ts")).href);
        check(!!a && a.diagnostics.some((d) => d.code === "TS2322") && a.diagnostics.some((d) => d.code === "eqeqeq"), "MCP: a.ts carries tsc + eslint diagnostics over the wire");
        check(content[1] && /^Sources — typescript: 1 issue/.test(content[1].text), "MCP: second content block is the per-linter summary");
        const local = novaMsgs.find((m) => m.type === "tool_call_local" && m.tool === "getDiagnostics");
        check(!!local && local.result.count === 3 && /typescript/.test(local.result.summary), "MCP: ws-server told Nova about the local call (tool_call_local, 3 diagnostics)");
        sock.close();
        finish();
      });
      sock.on("error", (e) => { check(false, "MCP socket error: " + e.message); clearTimeout(timer); finish(); });
    }, 50);
  });
}

main().catch((err) => { console.error("FAIL: " + err.stack); process.exit(1); });
