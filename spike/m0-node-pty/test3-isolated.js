// test3-isolated.js — parent script that mimics how Nova spawns ws-server.js.
// Strips PATH to the bare minimum (no nvm, no /usr/local/bin), passes only
// HOME + a Nova-like trimmed env, and verifies the child still works.

const { spawn } = require("child_process");
const path = require("path");

// Nova does NOT source .zshrc — its environment is what login provides.
// To simulate "worst case", we hand the child a stripped PATH that excludes
// the nvm bin dir entirely. We launch the child via the SAME node we're
// running under, by absolute path (which is how Nova would resolve it).
const nodeBinary = process.execPath; // absolute path to current node
const childScript = path.join(__dirname, "test3-child.js");

console.log("[parent] launching child:", nodeBinary, childScript);
console.log("[parent] using stripped PATH (no nvm, no /usr/local/bin)");

const child = spawn(nodeBinary, [childScript], {
  cwd: __dirname,
  env: {
    HOME: process.env.HOME,
    USER: process.env.USER,
    LANG: process.env.LANG || "en_US.UTF-8",
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin", // bare minimum, NO nvm, NO user bins
  },
  stdio: ["pipe", "pipe", "pipe"],
});

child.stdout.on("data", (chunk) => {
  // child emits JSON lines — Nova reads them similarly
  chunk
    .toString("utf8")
    .split("\n")
    .filter(Boolean)
    .forEach((line) => {
      try {
        const msg = JSON.parse(line);
        console.log(`[child:${msg.level}]`, msg.msg, msg.data ?? "");
      } catch {
        console.log("[child:raw]", line);
      }
    });
});

child.stderr.on("data", (chunk) => {
  process.stderr.write(`[child:stderr] ${chunk}`);
});

child.on("exit", (code, signal) => {
  console.log(`[parent] child exited code=${code} signal=${signal}`);
  process.exit(code ?? 1);
});
