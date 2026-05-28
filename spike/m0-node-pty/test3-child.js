// test3-child.js — runs as a subprocess simulating ws-server.js spawned by Nova.
// Parent strips PATH down to a Nova-like minimum; this child must still:
//   1) require() node-pty (loads native .node)
//   2) pty.spawn() claude via absolute path
//   3) capture --version output
//   4) signal success on stdout (Nova receives JSON lines)

const path = require("path");
const os = require("os");

function emit(level, msg, data) {
  process.stdout.write(JSON.stringify({ level, msg, data }) + "\n");
}

emit("info", "child started", {
  arch: process.arch,
  node: process.version,
  cwd: process.cwd(),
  pathEnv: process.env.PATH || "(empty)",
  homeEnv: process.env.HOME,
});

let pty;
try {
  pty = require("@homebridge/node-pty-prebuilt-multiarch");
  emit("info", "node-pty loaded OK");
} catch (err) {
  emit("error", "node-pty load FAILED", { message: err.message, stack: err.stack });
  process.exit(1);
}

const claudePath = path.join(os.homedir(), ".local", "bin", "claude");
emit("info", "spawning claude", { binary: claudePath });

const term = pty.spawn(claudePath, ["--version"], {
  name: "xterm-256color",
  cols: 80,
  rows: 24,
  cwd: os.homedir(),
  env: { ...process.env, TERM: "xterm-256color" },
});

let captured = "";
term.onData((data) => {
  captured += data;
});

term.onExit(({ exitCode, signal }) => {
  emit("info", "pty exited", { exitCode, signal, captured: captured.trim() });
  const version = captured.match(/\d+\.\d+\.\d+/);
  if (version) {
    emit("result", "PASS", { version: version[0] });
    process.exit(0);
  } else {
    emit("result", "FAIL", { reason: "no version in output", raw: captured });
    process.exit(1);
  }
});

setTimeout(() => {
  emit("result", "FAIL", { reason: "timeout" });
  term.kill();
  process.exit(1);
}, 10000);
