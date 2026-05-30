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
import { listSessions, streamSessionTranscript } from "./list-sessions.mjs";

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
  const { port, apiKey, model: initialModel = "claude-sonnet-4-6", callNovaTool, log, claudePath, getBridgeInfo } = opts;

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
    review:
      "Review the selected code for style, correctness, and security issues. Rank findings by severity (blocker / major / minor / nit) and explain each in one sentence.",
    optimize:
      "Suggest performance and memory improvements for the selected code. Show a before / after with a one-line justification of the gain (algorithmic complexity, allocations avoided, etc.). Skip premature optimizations.",
    simplify:
      "Simplify the selected code: extract sub-functions where it helps readability, remove dead branches, flatten nesting, and prefer idiomatic constructs. Show the cleaner version and note what changed.",
    types:
      "Add idiomatic type annotations to the selected code (TypeScript types, Python type hints, JSDoc, etc.) without changing the runtime behavior. Pick the language's most natural style.",
    security:
      "Run a focused security review of the selected code: input validation, injection vectors, auth/authz holes, secret leakage, unsafe deserialization, OWASP Top 10. Reference CWE numbers when relevant.",
    rename:
      "Suggest clearer names for the variables, functions, types, and parameters in the selected code. List each old → new with a one-line rationale. Don't rewrite the logic.",
    commit:
      "Propose a Conventional Commit message for the workspace's current uncommitted changes.\n\n1. First, call the `getGitDiff` tool (or run `git diff` if the tool is unavailable) — try staged changes first (`staged: true`); if empty, fall back to unstaged.\n2. Read the diff and write a commit message in the Conventional Commits style: `<type>(<scope>): <subject>` followed by a blank line and a wrapped body explaining the *why* (one short paragraph or a few bullets).\n3. Use the type taxonomy the repo's recent commits use (see `git log -5` if uncertain).\n4. End with the message in a single ```text code block ready to copy.",
    changelog:
      "Draft the next CHANGELOG entry from recent commits.\n\n1. Detect the previous release range: call `getGitLog` with `format: \"oneline\"` and no range to look at recent history; identify the latest tag (commits with `chore(release):` subjects or matching the repo's tag style).\n2. Call `getGitLog` again with `range: \"<last-tag>..HEAD\"` and `format: \"full\"` to read every commit since the last release.\n3. Group changes under Keep-A-Changelog-style headings: Added / Changed / Fixed / Removed / Documentation as appropriate. Skip pure chore(release) commits.\n4. Output the entry inside a single ```markdown code block, ready to drop into CHANGELOG.md under the new version header. Don't invent a date or version number — leave placeholders.",
    pr:
      "Draft a pull-request description from the current branch's commits.\n\n1. Call `getGitLog` with `range: \"main..HEAD\"` and `format: \"full\"` to read every commit on this branch.\n2. Call `getGitDiff` with `range: \"main..HEAD\"` and `stat: true` for a high-level view of files touched.\n3. Produce the PR body with this structure:\n   - **Summary** — 2 to 3 sentences on what this PR does and why.\n   - **What changed** — bulleted list grouped logically (not just `git log` verbatim).\n   - **Test plan** — checklist of things to verify before merging.\n4. Output everything inside one ```markdown code block ready to paste into the GitHub PR description field.",
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

  // Track every open chat client so we can broadcast bridge-status
  // updates when MCP clients connect/disconnect on the parallel
  // WebSocket. Added on `connection`, removed on `close`.
  const chatClients = new Set();

  // The last resume request received from the Nova sidebar that
  // hasn't been picked up by any client yet. If the user clicks
  // "Chat (web)" while no chat tab is open, the broadcast goes
  // nowhere; we stash the sessionId here and replay it to the next
  // client that connects. Cleared once delivered.
  let pendingResumeForNextClient = null;

  // ── WebSocket server ──────────────────────────────────────────
  // noServer + manual upgrade routing so a sibling WSS (cli-session
  // on /cli) can coexist on the same HTTP server. Otherwise the first
  // WSS attached via {server} captures every upgrade and rejects
  // everything that doesn't match its path filter, leaving /cli with
  // HTTP 400.
  const wss = new WebSocketServer({ noServer: true });
  httpServer.on("upgrade", (req, socket, head) => {
    const path = (req.url || "").split("?")[0];
    if (path === "/ws") {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
    }
    // Other paths (e.g. /cli) are handled by other upgrade listeners.
  });

  wss.on("connection", (socket, req) => {
    log("info", `chat: ws client connected from ${req.socket.remoteAddress}`);
    chatClients.add(socket);

    let currentAbortController = null;
    let currentSessionId = null;

    const send = (msg) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
    };

    // Push the current config to the client immediately so the model
    // picker, mode badge, and theme override reflect reality before the
    // first session event.
    send({
      type: "config",
      defaultModel: model,
      mode: chatMode,
      theme: process.env.CC_CHAT_THEME || "auto",
    });

    // Initial bridge status — port + connected client count read straight
    // from ws-server. Pushed again whenever clients connect/disconnect
    // (see broadcastBridgeStatus in ws-server.js).
    const initialBridge = getBridgeInfo ? getBridgeInfo() : null;
    if (initialBridge) send({ type: "bridge_status", ...initialBridge });

    // If a "Chat (web)" sidebar click landed before this client was
    // alive, replay it now so the resume request isn't lost.
    if (pendingResumeForNextClient) {
      send({ type: "resume_external", sessionId: pendingResumeForNextClient });
      pendingResumeForNextClient = null;
    }

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

      if (msg.type === "list_sessions") {
        // Reply with sessions from ~/.claude/projects/<cwd>/. Only
        // makes practical sense in CLI mode (the SDK uses its own
        // session store), but returning the list anyway lets the
        // user see what's available either way.
        try {
          const cwd = process.env.CC_WORKSPACE || process.cwd();
          const sessions = await listSessions(cwd, { limit: 30 });
          send({ type: "sessions", sessions });
        } catch (err) {
          log("warn", `chat: listSessions failed: ${err.message}`);
          send({ type: "sessions", sessions: [] });
        }
        return;
      }

      if (msg.type === "resume_session" && typeof msg.sessionId === "string") {
        // Mark this session as the one to attach to on the next
        // user_message. The CLI driver passes --resume <id>; the SDK
        // path's `resume:` option uses the same variable. Note that
        // SDK and CLI session stores are NOT interchangeable — the
        // user is responsible for picking a session that matches the
        // currently active chatMode.
        currentSessionId = msg.sessionId;
        log("info", `chat: resuming session ${msg.sessionId}`);

        // Replay the user/assistant turns of the chosen session so
        // the user has visual continuity before sending the next
        // prompt. Tool calls are skipped for now (they'd add a lot of
        // noise on replay; can be surfaced later behind a toggle).
        send({ type: "history_begin", sessionId: msg.sessionId });
        try {
          const cwd = process.env.CC_WORKSPACE || process.cwd();
          await streamSessionTranscript(cwd, msg.sessionId, (evt) => {
            if (evt.kind === "message") {
              send({ type: "history_message", role: evt.role, text: evt.text, ts: evt.ts });
            } else if (evt.kind === "tool_use") {
              send({ type: "history_tool_use", name: evt.name, input: evt.input, ts: evt.ts });
            } else if (evt.kind === "tool_result") {
              send({ type: "history_tool_result", name: evt.name, text: evt.text, isError: evt.isError, ts: evt.ts });
            }
          });
        } catch (err) {
          log("warn", `chat: streamSessionTranscript failed: ${err.message}`);
        }
        send({ type: "history_end" });
        send({ type: "session_resumed", sessionId: msg.sessionId });
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
      chatClients.delete(socket);
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
    httpServer, // exposed so cli-session can attach a sibling /cli WSS
    // Broadcaster called by ws-server.js when MCP clients connect or
    // disconnect, so the chat UI's statusbar reflects live state.
    pushBridgeStatus(info) {
      const payload = JSON.stringify({ type: "bridge_status", ...info });
      for (const sock of chatClients) {
        if (sock.readyState === sock.OPEN) {
          try { sock.send(payload); } catch (_) {}
        }
      }
    },
    // Triggered when the user clicks a session in the Nova sidebar
    // and picks "Chat (web)" from the action panel. Tells every open
    // chat client to resume that session (same effect as picking it
    // from the in-chat Resume… menu). If no chat client is open yet,
    // stash the sessionId so the next one to connect picks it up.
    pushResumeRequest(sessionId) {
      const payload = JSON.stringify({ type: "resume_external", sessionId });
      let delivered = 0;
      for (const sock of chatClients) {
        if (sock.readyState === sock.OPEN) {
          try { sock.send(payload); delivered++; } catch (_) {}
        }
      }
      // No live client → remember for next connect (e.g. user hits
      // refresh after clicking the sidebar action).
      if (delivered === 0) pendingResumeForNextClient = sessionId;
    },
    stop: () =>
      new Promise((resolve) => {
        wss.close(() => httpServer.close(() => resolve()));
      }),
  };
}
