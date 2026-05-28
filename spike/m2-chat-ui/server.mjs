// server.mjs — HTTP + WebSocket server for the M2 chat UI demo.
//
// Endpoints :
//   GET  /              → public/index.html
//   GET  /chat.js       → public/chat.js
//   GET  /chat.css      → public/chat.css
//   GET  /lib/<file>    → public/lib/<file>   (marked, highlight.js)
//   WS   /ws            → chat WebSocket
//
// Chat WebSocket protocol :
//
//   Client → Server :
//     { type: "user_message", text: string }
//     { type: "abort" }
//
//   Server → Client :
//     { type: "session_started", sessionId, model }
//     { type: "assistant_text",  chunk }
//     { type: "assistant_tool_use", name, input }
//     { type: "tool_result", name, text, isError }
//     { type: "result", success, cost, tokens }
//     { type: "error", message }

import { createServer } from "http";
import { readFile } from "fs/promises";
import { join, dirname, extname } from "path";
import { fileURLToPath } from "url";
import { WebSocketServer } from "ws";
import { query, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";

import { allMockTools, allowedToolNames } from "./chat-tool-mocks.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, "public");
const PORT = Number(process.env.PORT) || 5180;

if (!process.env.ANTHROPIC_API_KEY) {
  console.error("ERROR: ANTHROPIC_API_KEY not set.");
  console.error("Run with :  npm run start:1pass");
  console.error("       or :  export ANTHROPIC_API_KEY=sk-ant-... && npm start");
  process.exit(1);
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
};

// --- HTTP server (static files) -------------------------------------------

const httpServer = createServer(async (req, res) => {
  try {
    let path = req.url.split("?")[0];
    if (path === "/") path = "/index.html";

    // Prevent directory traversal
    if (path.includes("..")) {
      res.writeHead(403);
      return res.end("Forbidden");
    }

    const filePath = join(PUBLIC_DIR, path);
    const data = await readFile(filePath);
    const mime = MIME[extname(filePath)] || "application/octet-stream";
    res.writeHead(200, { "content-type": mime, "cache-control": "no-cache" });
    res.end(data);
  } catch (err) {
    if (err.code === "ENOENT") {
      res.writeHead(404);
      res.end("Not Found");
    } else {
      console.error("HTTP error :", err);
      res.writeHead(500);
      res.end("Internal Server Error");
    }
  }
});

// --- WebSocket server -----------------------------------------------------

const wss = new WebSocketServer({ server: httpServer, path: "/ws" });

const novaServer = createSdkMcpServer({
  name: "nova",
  version: "0.0.0",
  tools: allMockTools,
});

wss.on("connection", (socket, req) => {
  console.log(`[ws] client connected from ${req.socket.remoteAddress}`);

  let currentAbortController = null;
  let currentSessionId = null;

  const send = (msg) => {
    if (socket.readyState === socket.OPEN) {
      socket.send(JSON.stringify(msg));
    }
  };

  socket.on("message", async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString("utf8"));
    } catch {
      send({ type: "error", message: "invalid JSON" });
      return;
    }

    if (msg.type === "abort") {
      if (currentAbortController) {
        currentAbortController.abort();
        console.log("[ws] aborted current query");
      }
      return;
    }

    if (msg.type !== "user_message" || typeof msg.text !== "string") {
      send({ type: "error", message: "unsupported message type" });
      return;
    }

    if (currentAbortController) {
      send({ type: "error", message: "previous query still running" });
      return;
    }

    currentAbortController = new AbortController();
    console.log(`[ws] user_message: ${msg.text.slice(0, 60)}…`);

    try {
      const q = query({
        prompt: msg.text,
        options: {
          model: "claude-sonnet-4-6",
          tools: [],
          settingSources: [],
          mcpServers: { nova: novaServer },
          allowedTools: allowedToolNames,
          abortController: currentAbortController,
          // Resume previous session if we have one (multi-turn)
          ...(currentSessionId ? { resume: currentSessionId } : {}),
        },
      });

      for await (const event of q) {
        switch (event.type) {
          case "system":
            if (event.subtype === "init") {
              if (!currentSessionId) currentSessionId = event.session_id;
              send({
                type: "session_started",
                sessionId: event.session_id,
                model: event.model ?? "unknown",
              });
            }
            break;

          case "assistant": {
            const content = event.message?.content ?? [];
            for (const block of content) {
              if (block.type === "text") {
                send({ type: "assistant_text", chunk: block.text });
              } else if (block.type === "tool_use") {
                send({
                  type: "assistant_tool_use",
                  name: block.name,
                  input: block.input,
                });
              }
            }
            break;
          }

          case "user": {
            // tool_result blocks come back inside user messages
            const content = event.message?.content ?? [];
            for (const block of content) {
              if (block.type === "tool_result") {
                const text = Array.isArray(block.content)
                  ? block.content.map((c) => c.text ?? "").join("")
                  : (block.content ?? "");
                send({
                  type: "tool_result",
                  name: block.name ?? "unknown",
                  text,
                  isError: !!block.is_error,
                });
              }
            }
            break;
          }

          case "result":
            send({
              type: "result",
              success: event.subtype === "success",
              cost: event.total_cost_usd ?? null,
              tokens: event.usage
                ? { input: event.usage.input_tokens, output: event.usage.output_tokens }
                : null,
              ...(event.subtype !== "success" ? { error: event.error ?? String(event) } : {}),
            });
            break;

          // Other event types (stream_event, hooks, etc.) — silently consumed
          default:
            break;
        }
      }
    } catch (err) {
      if (err.name === "AbortError") {
        send({ type: "error", message: "query aborted" });
      } else {
        console.error("[ws] query error :", err);
        send({ type: "error", message: err.message || String(err) });
      }
    } finally {
      currentAbortController = null;
    }
  });

  socket.on("close", () => {
    console.log("[ws] client disconnected");
    if (currentAbortController) currentAbortController.abort();
  });

  socket.on("error", (err) => {
    console.error("[ws] socket error :", err.message);
  });
});

httpServer.listen(PORT, "127.0.0.1", () => {
  console.log("─".repeat(60));
  console.log(` M2 chat UI demo running`);
  console.log(`─ Open : http://127.0.0.1:${PORT}/`);
  console.log(`─ WS   : ws://127.0.0.1:${PORT}/ws`);
  console.log(`─ Tools: ${allowedToolNames.join(", ")}`);
  console.log("─ Hit Ctrl+C to stop.");
  console.log("─".repeat(60));
});
