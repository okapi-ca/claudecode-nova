// Test 1 — pty.spawn('zsh') + capture echo output
// Validates that node-pty loads and produces a usable PTY.

const pty = require("@homebridge/node-pty-prebuilt-multiarch");

console.log("[test1] node-pty loaded:", typeof pty.spawn === "function");
console.log("[test1] process.arch =", process.arch, "node =", process.version);

const term = pty.spawn("/bin/zsh", ["-i"], {
  name: "xterm-256color",
  cols: 80,
  rows: 24,
  cwd: process.cwd(),
  env: { ...process.env, TERM: "xterm-256color" },
});

let captured = "";
let resolved = false;

term.onData((data) => {
  captured += data;
  process.stdout.write(data);
  if (captured.includes("MARC_M0_SENTINEL_OK") && !resolved) {
    resolved = true;
    console.log("\n[test1] PASS — sentinel echoed back through PTY");
    term.kill();
  }
});

term.onExit(({ exitCode, signal }) => {
  console.log(`\n[test1] PTY exited code=${exitCode} signal=${signal}`);
  if (!resolved) {
    console.error("[test1] FAIL — sentinel never appeared in PTY output");
    process.exit(1);
  }
  process.exit(0);
});

// Give zsh a moment to print its prompt, then send the test command.
setTimeout(() => {
  console.log("\n[test1] writing: echo MARC_M0_SENTINEL_OK");
  term.write("echo MARC_M0_SENTINEL_OK\n");
}, 500);

setTimeout(() => {
  if (!resolved) {
    console.error("[test1] FAIL — timeout (5s) without sentinel");
    term.kill();
    process.exit(1);
  }
}, 5000);
