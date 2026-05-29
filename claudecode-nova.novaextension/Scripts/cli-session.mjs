// cli-session.mjs — terminal-style CLI panel served alongside the
// chat-session HTTP server. Spawns `claude` in a real PTY (via
// node-pty) and pipes data both ways over a WebSocket at /cli.
//
// Lifecycle :
//   1. ws-server.js calls attach({ httpServer, claudeCommand, claudeArgs, log })
//   2. attach() mounts a WebSocketServer on /cli of the existing HTTP server
//   3. Each ws connection spawns one PTY child running `claude` with the
//      user-configured args; the child dies when the ws closes
//
// Wire format (JSON messages on the ws) :
//   client → server : { type: "input", data: "<string>" }
//                     { type: "resize", cols: <n>, rows: <n> }
//   server → client : { type: "output", data: "<string>" }
//                     { type: "exit", code: <n> }

import { WebSocketServer } from "ws";

export function attach({ httpServer, claudeCommand = "claude", claudeArgs = "", log = console.log }) {
  // Lazy-require node-pty so a missing native build doesn't kill the
  // chat path. If load fails we surface a friendly error to clients
  // and leave the rest of the server functional.
  let pty = null;
  async function ensurePty() {
    if (pty !== null) return pty;
    try {
      pty = await import("node-pty");
    } catch (err) {
      log("error", `cli: node-pty load failed: ${err.message}`);
      pty = false;
    }
    return pty;
  }

  // noServer + manual upgrade routing — required to coexist with the
  // chat-session WSS on /ws on the same httpServer. See the comment
  // in chat-session.mjs for the rationale.
  const wss = new WebSocketServer({ noServer: true });
  httpServer.on("upgrade", (req, socket, head) => {
    const path = (req.url || "").split("?")[0];
    if (path === "/cli") {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
    }
  });

  wss.on("connection", async (socket, req) => {
    log("info", `cli: ws client connected from ${req.socket.remoteAddress}`);

    const ptyMod = await ensurePty();
    if (!ptyMod) {
      try {
        socket.send(JSON.stringify({ type: "output", data: "\r\n\x1b[31m[node-pty unavailable — terminal disabled]\x1b[0m\r\n" }));
      } catch (_) {}
      try { socket.close(); } catch (_) {}
      return;
    }

    // Tokenize the user-configured args. Simple whitespace split — good
    // enough for "--continue --model claude-opus-4-8". Users who need
    // quoted args can adjust the setting; we don't ship a shell here.
    const args = (claudeArgs || "").trim().split(/\s+/).filter(Boolean);

    // Nova's subprocess inherits a stripped PATH that typically excludes
    // ~/.local/bin (where `claude` lives) and other user shell dirs. We
    // extend it with the usual install locations so plain "claude"
    // resolves without forcing the user to configure an absolute path.
    const env = { ...process.env, TERM: "xterm-256color" };
    if (!claudeCommand.startsWith("/")) {
      const home = process.env.HOME || "";
      const extra = [`${home}/.local/bin`, "/usr/local/bin", "/opt/homebrew/bin"];
      const cur = (env.PATH || "").split(":");
      env.PATH = [...new Set([...extra, ...cur])].filter(Boolean).join(":");
    }

    let child;
    try {
      child = ptyMod.spawn(claudeCommand, args, {
        name: "xterm-256color",
        cols: 80,
        rows: 24,
        cwd: process.env.CC_WORKSPACE || process.env.HOME,
        env,
      });
    } catch (err) {
      log("error", `cli: pty spawn failed: ${err.message}`);
      try {
        socket.send(JSON.stringify({ type: "output", data: `\r\n\x1b[31m[spawn failed: ${err.message}]\x1b[0m\r\n` }));
      } catch (_) {}
      try { socket.close(); } catch (_) {}
      return;
    }

    child.onData((data) => {
      if (socket.readyState === socket.OPEN) {
        socket.send(JSON.stringify({ type: "output", data }));
      }
    });

    child.onExit(({ exitCode }) => {
      log("info", `cli: pty exited (code=${exitCode})`);
      if (socket.readyState === socket.OPEN) {
        socket.send(JSON.stringify({ type: "exit", code: exitCode }));
        try { socket.close(); } catch (_) {}
      }
    });

    socket.on("message", (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString("utf8")); }
      catch { return; }

      if (msg.type === "input" && typeof msg.data === "string") {
        try { child.write(msg.data); } catch (_) {}
      } else if (msg.type === "resize" && Number.isInteger(msg.cols) && Number.isInteger(msg.rows)) {
        try { child.resize(msg.cols, msg.rows); } catch (_) {}
      }
    });

    socket.on("close", () => {
      log("info", "cli: ws client disconnected, killing pty");
      try { child.kill(); } catch (_) {}
    });

    socket.on("error", (err) => log("error", `cli ws socket error: ${err.message}`));
  });

  return {
    stop: () => new Promise((resolve) => wss.close(() => resolve())),
  };
}
