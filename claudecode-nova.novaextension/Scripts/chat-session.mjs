// chat-session.mjs — embedded chat server for the claudecode-nova extension.
//
// Loaded by ws-server.js when claudecode.chat.enabled is on. Spawns an HTTP
// server (fixed port, configurable) that serves the chat UI assets in
// ./chat-ui/ and exposes a WebSocket /ws endpoint. Drives Claude via the
// Claude Agent SDK with in-process tool wrappers that round-trip Nova calls
// through ws-server.js → main.js → editor.
//
// Lifecycle :
//   1. ws-server.js calls init({ port, apiKey, callNovaTool, log })
//   2. init starts the HTTP+WS server, returns a stop() function
//   3. ws-server.js calls stop() on shutdown
//
// The chat server is INDEPENDENT of the MCP server — they share the Nova
// round-trip plumbing (callNovaTool), but run on different ports and serve
// different clients.

import { createServer } from "http";
import { readFile } from "fs/promises";
import { dirname, extname, join } from "path";
import { fileURLToPath } from "url";
import { WebSocketServer } from "ws";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { buildNovaToolsServer } from "./chat-tool-wrappers.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CHAT_UI_DIR = join(__dirname, "chat-ui");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js":   "application/javascript; charset=utf-8",
  ".mjs":  "application/javascript; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg":  "image/svg+xml",
  ".png":  "image/png",
};

/**
 * Start the chat server. Returns a stop() function.
 *
 * @param {Object}   opts
 * @param {number}   opts.port           HTTP port (e.g. 5180)
 * @param {string}   opts.apiKey         Anthropic API key (already resolved)
 * @param {string}   opts.model          "claude-sonnet-4-6", etc.
 * @param {Function} opts.callNovaTool   async (toolName, args) → result (Phase 3)
 * @param {Function} opts.log            (level, msg, data?) → void
 */
export async function init(opts) {
  const { port, apiKey, model = "claude-sonnet-4-6", callNovaTool, log } = opts;

  if (!apiKey) {
    throw new Error("chat-session: apiKey is required");
  }

  // The SDK reads this from process.env (it's an env-driven API)
  process.env.ANTHROPIC_API_KEY = apiKey;

  const { server: novaServer, toolNames: allowedToolNames } = buildNovaToolsServer({ callNovaTool, log });
  log("info", `chat: ${allowedToolNames.length} Nova tools exposed to SDK`);

  // Slash command templates. Each maps to a system-style prompt; the user
  // can pass additional `text` which gets appended after the template.
  // Context injection (current selection + filePath) is added automatically
  // by the user_message handler when injectContext is true.
  const SLASH_TEMPLATES = {
    explain:
      "Explain in detail what the selected code does, including any non-obvious behavior, edge cases, and dependencies. Be concise but thorough.",
    refactor:
      "Suggest a refactor of the selected code for clarity, maintainability, and idiomatic style. Show the cleaned-up version with a short rationale.",
    test:
      "Write tests for the selected code. Use the test framework idiomatic to the file's language (Jest/Vitest for JS/TS, pytest for Python, etc.). Cover the happy path and at least one edge case.",
    doc:
      "Add inline documentation to the selected code: JSDoc for JS/TS, docstrings for Python, doc comments for the file's idiomatic style. Don't change behavior.",
    fix:
      "Find any bugs, logic errors, or potential issues in the selected code and propose fixes. If the code looks correct, say so explicitly rather than inventing problems.",
  };

  // Extract the text payload from an MCP tool result. Tool results come
  // back wrapped as { content: [{ type: "text", text: "<json>" }] } where
  // <json> is whatever the underlying Nova tool returned (already
  // JSON-serialised by ws-server.js).
  function extractToolText(payload) {
    if (!payload || !Array.isArray(payload.content)) return null;
    const block = payload.content.find((c) => c && c.type === "text");
    if (!block || typeof block.text !== "string") return null;
    return block.text;
  }

  // Best-effort: pull the user's current selection + file path from Nova.
  // Returns a markdown block ready to prepend to the prompt, or null if
  // no selection / lookup failed. Failures are logged but never thrown so
  // a Nova hiccup never blocks chat input.
  async function fetchWorkspaceContext() {
    try {
      const payload = await callNovaTool("getCurrentSelection", {});
      const raw = extractToolText(payload);
      if (!raw) return null;

      let sel;
      try { sel = JSON.parse(raw); }
      catch { return null; }

      const lines = ["### Workspace context"];
      if (sel.filePath) lines.push(`- File: \`${sel.filePath}\``);
      if (sel.startLine != null && sel.endLine != null) {
        lines.push(`- Lines: ${sel.startLine + 1}–${sel.endLine + 1}`);
      }
      if (sel.text && !sel.isEmpty) {
        lines.push("", "Selected code:", "```", sel.text, "```");
      } else if (sel.filePath) {
        lines.push("- (no selection — the user has the file open but nothing highlighted)");
      } else {
        return null;
      }
      return lines.join("\n");
    } catch (err) {
      log("warn", `chat: failed to fetch workspace context: ${err.message}`);
      return null;
    }
  }

  // Assemble the final prompt from slash command + user text + context.
  // Order: template (if slash) → user text → context block.
  async function buildPrompt({ text, slashCommand, injectContext }) {
    const parts = [];
    if (slashCommand && SLASH_TEMPLATES[slashCommand]) {
      parts.push(SLASH_TEMPLATES[slashCommand]);
    }
    if (text && text.trim()) parts.push(text.trim());
    if (injectContext) {
      const ctx = await fetchWorkspaceContext();
      if (ctx) parts.push(ctx);
    }
    return parts.join("\n\n");
  }

  // ── HTTP server (static files) ─────────────────────────────────
  const httpServer = createServer(async (req, res) => {
    try {
      let path = (req.url || "/").split("?")[0];
      if (path === "/") path = "/index.html";
      if (path.includes("..")) {
        res.writeHead(403); return res.end("Forbidden");
      }
      const filePath = join(CHAT_UI_DIR, path);
      const data = await readFile(filePath);
      const mime = MIME[extname(filePath)] || "application/octet-stream";
      res.writeHead(200, { "content-type": mime, "cache-control": "no-cache" });
      res.end(data);
    } catch (err) {
      if (err.code === "ENOENT") { res.writeHead(404); res.end("Not Found"); }
      else { log("error", `chat http error: ${err.message}`); res.writeHead(500); res.end("Internal Error"); }
    }
  });

  // ── WebSocket server ──────────────────────────────────────────
  const wss = new WebSocketServer({ server: httpServer, path: "/ws" });

  wss.on("connection", (socket, req) => {
    log("info", `chat: ws client connected from ${req.socket.remoteAddress}`);

    let currentAbortController = null;
    let currentSessionId = null;

    const send = (msg) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
    };

    socket.on("message", async (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString("utf8")); }
      catch { send({ type: "error", message: "invalid JSON" }); return; }

      if (msg.type === "abort") {
        if (currentAbortController) {
          currentAbortController.abort();
          log("info", "chat: query aborted");
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

      // Slash command + workspace context injection. Both optional — the
      // client decides per-message whether to use them.
      const prompt = await buildPrompt({
        text: msg.text,
        slashCommand: msg.slashCommand || null,
        injectContext: msg.injectContext === true,
      });

      try {
        const q = query({
          prompt,
          options: {
            model,
            tools: [],
            settingSources: [],
            mcpServers: { nova: novaServer },
            allowedTools: allowedToolNames,
            abortController: currentAbortController,
            ...(currentSessionId ? { resume: currentSessionId } : {}),
          },
        });

        for await (const event of q) {
          switch (event.type) {
            case "system":
              if (event.subtype === "init") {
                if (!currentSessionId) currentSessionId = event.session_id;
                send({ type: "session_started", sessionId: event.session_id, model: event.model ?? model });
              }
              break;
            case "assistant": {
              const content = event.message?.content ?? [];
              for (const block of content) {
                if (block.type === "text") send({ type: "assistant_text", chunk: block.text });
                else if (block.type === "tool_use") send({ type: "assistant_tool_use", name: block.name, input: block.input });
              }
              break;
            }
            case "user": {
              const content = event.message?.content ?? [];
              for (const block of content) {
                if (block.type === "tool_result") {
                  const text = Array.isArray(block.content)
                    ? block.content.map((c) => c.text ?? "").join("")
                    : (block.content ?? "");
                  send({ type: "tool_result", name: block.name ?? "unknown", text, isError: !!block.is_error });
                }
              }
              break;
            }
            case "result":
              send({
                type: "result",
                success: event.subtype === "success",
                cost: event.total_cost_usd ?? null,
                tokens: event.usage ? { input: event.usage.input_tokens, output: event.usage.output_tokens } : null,
                ...(event.subtype !== "success" ? { error: event.error ?? String(event) } : {}),
              });
              break;
          }
        }
      } catch (err) {
        if (err.name === "AbortError") {
          send({ type: "error", message: "query aborted" });
        } else {
          log("error", `chat query error: ${err.message}`);
          send({ type: "error", message: err.message || String(err) });
        }
      } finally {
        currentAbortController = null;
      }
    });

    socket.on("close", () => {
      if (currentAbortController) currentAbortController.abort();
      log("info", "chat: ws client disconnected");
    });

    socket.on("error", (err) => log("error", `chat ws socket error: ${err.message}`));
  });

  // ── Start listening ───────────────────────────────────────────
  await new Promise((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(port, "127.0.0.1", () => {
      log("info", `chat server listening on http://127.0.0.1:${port}/`);
      resolve();
    });
  });

  return {
    port,
    stop: () =>
      new Promise((resolve) => {
        wss.close(() => httpServer.close(() => resolve()));
      }),
  };
}
