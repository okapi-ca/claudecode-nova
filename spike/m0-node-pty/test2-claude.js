// Test 2 — pty.spawn('claude', ['--version'])
// Smoke test: does the claude binary work when spawned inside a PTY?

const pty = require("@homebridge/node-pty-prebuilt-multiarch");
const path = require("path");
const os = require("os");

const claudePath = path.join(os.homedir(), ".local", "bin", "claude");
console.log("[test2] claude path =", claudePath);

const term = pty.spawn(claudePath, ["--version"], {
  name: "xterm-256color",
  cols: 80,
  rows: 24,
  cwd: process.cwd(),
  env: { ...process.env, TERM: "xterm-256color" },
});

let captured = "";

term.onData((data) => {
  captured += data;
  process.stdout.write(data);
});

term.onExit(({ exitCode, signal }) => {
  console.log(`\n[test2] PTY exited code=${exitCode} signal=${signal}`);
  console.log(`[test2] captured ${captured.length} bytes`);
  const versionMatch = captured.match(/\d+\.\d+\.\d+/);
  if (versionMatch) {
    console.log(`[test2] PASS — claude version detected: ${versionMatch[0]}`);
    process.exit(0);
  } else {
    console.error("[test2] FAIL — no semver pattern found in output");
    process.exit(1);
  }
});

setTimeout(() => {
  console.error("[test2] FAIL — timeout (10s)");
  term.kill();
  process.exit(1);
}, 10000);
