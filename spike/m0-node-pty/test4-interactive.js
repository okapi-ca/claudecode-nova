// Test 4 — interactive claude session through node-pty.
//
// Spawns 'claude' (no args = TUI mode) inside a real PTY, then bridges:
//   - parent stdin  → pty.write   (keystrokes flow through, raw mode)
//   - pty stdout    → parent stdout (TUI rendering: colors, cursor, boxes)
//   - SIGWINCH       → pty.resize  (terminal resizes propagate)
//
// What this proves end-to-end:
//   1. claude detects the PTY as a TTY → enters interactive TUI mode
//   2. Keypresses (including Ctrl+chars, arrow keys, Esc) flow through
//   3. ANSI escape sequences render correctly
//   4. Resize handling works
//
// Exit: type /quit inside claude, OR press Ctrl+\ (SIGQUIT) in the parent
// terminal to forcibly tear down the wrapper.

const pty = require("@homebridge/node-pty-prebuilt-multiarch");
const path = require("path");
const os = require("os");

const claudePath = path.join(os.homedir(), ".local", "bin", "claude");

console.log("─".repeat(60));
console.log(" M0 Test 4 — interactive claude session via node-pty");
console.log("─".repeat(60));
console.log(` claude binary : ${claudePath}`);
console.log(` terminal size : ${process.stdout.columns}×${process.stdout.rows}`);
console.log(` TERM          : ${process.env.TERM}`);
console.log(" Exit          : type /quit inside claude, or Ctrl+\\ to force");
console.log("─".repeat(60));
console.log("");

const term = pty.spawn(claudePath, [], {
  name: "xterm-256color",
  cols: process.stdout.columns || 80,
  rows: process.stdout.rows || 24,
  cwd: process.cwd(),
  env: { ...process.env, TERM: "xterm-256color" },
});

// PTY output → parent stdout (the TUI you see is fully rendered by claude)
term.onData((data) => {
  process.stdout.write(data);
});

// Put parent stdin into raw mode so every keystroke goes straight to claude
// (no line buffering, no echo, no Ctrl+C handling by the parent shell).
if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
}
process.stdin.resume();
process.stdin.setEncoding("utf8");

process.stdin.on("data", (chunk) => {
  // Ctrl+\ (0x1c) = wrapper kill switch — bypasses claude
  if (chunk === "\x1c") {
    cleanup(0, "wrapper kill switch (Ctrl+\\)");
    return;
  }
  term.write(chunk);
});

// Forward terminal resize events
process.stdout.on("resize", () => {
  const cols = process.stdout.columns;
  const rows = process.stdout.rows;
  term.resize(cols, rows);
});

term.onExit(({ exitCode, signal }) => {
  cleanup(exitCode ?? 0, `claude exited (code=${exitCode}, signal=${signal})`);
});

function cleanup(code, reason) {
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(false);
  }
  process.stdin.pause();
  // small spacer so the next shell prompt isn't glued to claude's last line
  process.stdout.write(`\n\n─── ${reason} ───\n`);
  process.exit(code);
}

process.on("SIGINT", () => {
  // Forward Ctrl+C to claude (don't kill the wrapper)
  term.write("\x03");
});
