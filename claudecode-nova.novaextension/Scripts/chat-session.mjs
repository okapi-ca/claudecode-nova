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
import { spawn } from "child_process";
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
  const { port, apiKey, model: initialModel = "claude-sonnet-4-6", callNovaTool, log, claudePath } = opts;

  // The currently-active model. Starts from the value `init()` was called
  // with (read by main.js from claudecode.chat.model), can be flipped at
  // runtime by a {type:"set_model"} message from the chat UI's picker.
  // Each user_message uses whatever is current at submission time, so the
  // user can A/B between Sonnet and Opus mid-conversation.
  let model = initialModel;

  // Two execution modes :
  //   - "sdk" : use @anthropic-ai/claude-agent-sdk with ANTHROPIC_API_KEY.
  //     Streaming + Nova tools + abort signal — full feature set.
  //   - "cli" : spawn `claude -p ... --output-format stream-json` as a
  //     subprocess. Uses the user's existing Claude Code CLI auth (OAuth
  //     Pro/Max session) so no API key is needed. Multi-turn via
  //     --resume <session_id>. Nova tools come from the CLI's own MCP
  //     bridge, not the SDK in-process tools.
  const chatMode = apiKey ? "sdk" : "cli";
  if (chatMode === "sdk") {
    process.env.ANTHROPIC_API_KEY = apiKey;
    log("info", "chat: using SDK mode (API key resolved)");
  } else {
    log("info", "chat: no API key — falling back to CLI subprocess mode (uses Claude Code session auth)");
  }

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

  // CLI subprocess driver. Spawns `claude -p ... --output-format stream-json`
  // and translates the CLI's event stream into the same wire format that
  // the SDK path emits (assistant_text / session_started / result), so the
  // frontend doesn't care which backend is active.
  function runClaudeCLI({ prompt, sessionId, send, log, abortController }) {
    return new Promise((resolve, reject) => {
      const claudeBin = claudePath || "claude";
      const args = [
        "-p", prompt,
        "--output-format", "stream-json",
        "--include-partial-messages",
        "--verbose", // required for stream-json to emit deltas
        "--model", model,
      ];
      if (sessionId) args.push("--resume", sessionId);

      // Inherit env; Nova passes a limited PATH so we extend it with the
      // usual install locations for the `claude` CLI when claudeBin is not
      // an absolute path.
      const env = { ...process.env };
      if (!claudeBin.startsWith("/")) {
        const home = process.env.HOME || "";
        const extra = [`${home}/.local/bin`, "/usr/local/bin", "/opt/homebrew/bin"];
        const cur = (env.PATH || "").split(":");
        env.PATH = [...new Set([...extra, ...cur])].filter(Boolean).join(":");
      }

      let child;
      try {
        child = spawn(claudeBin, args, {
          env,
          stdio: ["ignore", "pipe", "pipe"],
          signal: abortController?.signal,
        });
      } catch (err) {
        reject(err);
        return;
      }

      let stdoutBuf = "";
      let stderrBuf = "";
      let capturedSessionId = null;
      let lastCost = null;
      let lastUsage = null;

      child.stdout.on("data", (chunk) => {
        stdoutBuf += chunk.toString("utf8");
        let nl;
        while ((nl = stdoutBuf.indexOf("\n")) !== -1) {
          const line = stdoutBuf.slice(0, nl).trim();
          stdoutBuf = stdoutBuf.slice(nl + 1);
          if (!line) continue;
          let evt;
          try { evt = JSON.parse(line); }
          catch (err) { log("warn", `chat cli: bad json line: ${line.slice(0, 120)}`); continue; }

          // Map CLI events → frontend wire format.
          if (evt.type === "system" && evt.subtype === "init") {
            capturedSessionId = evt.session_id;
            send({ type: "session_started", sessionId: evt.session_id, model: evt.model ?? model, mode: "cli" });
          } else if (evt.type === "stream_event" && evt.event?.type === "content_block_delta") {
            const delta = evt.event.delta;
            if (delta?.type === "text_delta" && typeof delta.text === "string") {
              send({ type: "assistant_text", chunk: delta.text });
            } else if (delta?.type === "thinking_delta" && typeof delta.thinking === "string") {
              send({ type: "assistant_thinking", chunk: delta.thinking });
            }
          } else if (evt.type === "assistant" && Array.isArray(evt.message?.content)) {
            // Top-level assistant events carry committed message content,
            // including tool_use blocks. The stream_event deltas don't
            // include tool_use input directly, so we rely on this path
            // for tool-card display.
            for (const block of evt.message.content) {
              if (block?.type === "tool_use") {
                send({ type: "assistant_tool_use", name: block.name, input: block.input || {} });
              }
            }
          } else if (evt.type === "user" && Array.isArray(evt.message?.content)) {
            for (const block of evt.message.content) {
              if (block?.type === "tool_result") {
                const text = Array.isArray(block.content)
                  ? block.content.map((c) => c.text ?? "").join("")
                  : (block.content ?? "");
                send({ type: "tool_result", name: block.name ?? "unknown", text, isError: !!block.is_error });
              }
            }
          } else if (evt.type === "result") {
            lastCost = evt.total_cost_usd ?? null;
            lastUsage = evt.usage ?? null;
          }
        }
      });

      child.stderr.on("data", (chunk) => { stderrBuf += chunk.toString("utf8"); });

      child.on("error", (err) => reject(err));
      child.on("close", (code) => {
        if (code === 0) {
          send({
            type: "result",
            success: true,
            cost: lastCost,
            tokens: lastUsage ? { input: lastUsage.input_tokens, output: lastUsage.output_tokens } : null,
          });
          resolve({ sessionId: capturedSessionId });
        } else {
          send({
            type: "result",
            success: false,
            error: stderrBuf.trim().split("\n").slice(-3).join("\n") || `claude CLI exited with code ${code}`,
          });
          resolve({ sessionId: capturedSessionId }); // resolve, not reject — error already surfaced to client
        }
      });
    });
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

      if (msg.type === "set_model" && typeof msg.model === "string") {
        if (msg.model !== model) {
          log("info", `chat: switching model ${model} → ${msg.model}`);
          model = msg.model;
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

      // CLI mode: spawn `claude -p ...`, parse stream-json, map events.
      // Reuses the user's OAuth Pro/Max session, no API key needed.
      if (chatMode === "cli") {
        try {
          const { sessionId } = await runClaudeCLI({
            prompt,
            sessionId: currentSessionId,
            send,
            log,
            abortController: currentAbortController,
          });
          if (sessionId && !currentSessionId) currentSessionId = sessionId;
        } catch (err) {
          if (err.name === "AbortError") {
            send({ type: "error", message: "query aborted" });
          } else {
            log("error", `chat CLI error: ${err.message}`);
            send({ type: "error", message: err.message || String(err) });
          }
        } finally {
          currentAbortController = null;
        }
        return;
      }

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
                send({ type: "session_started", sessionId: event.session_id, model: event.model ?? model, mode: "sdk" });
              }
              break;
            case "assistant": {
              const content = event.message?.content ?? [];
              for (const block of content) {
                if (block.type === "text") send({ type: "assistant_text", chunk: block.text });
                else if (block.type === "thinking" && typeof block.thinking === "string") send({ type: "assistant_thinking", chunk: block.thinking });
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
