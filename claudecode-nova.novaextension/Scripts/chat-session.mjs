// chat-session.mjs — embedded chat server for the claudecode-nova extension.
//
// Loaded by ws-server.js when claudecode.chat.enabled is on. Spawns an HTTP
// server (fixed port, configurable) that serves the chat UI assets in
// ./chat-ui/ and exposes a WebSocket /ws endpoint. Drives Claude via the
// Claude Agent SDK in *streaming input* mode: one persistent Claude Code
// process per chat session, fed through an async generator, so follow-up
// turns don't pay a cold start, permission prompts reach the chat through
// the SDK control channel, Stop interrupts the current turn instead of
// killing the session, and images work in both auth modes.
//
// Two auth modes, same driver :
//   - "sdk"   : an Anthropic API key was resolved. Cost-tuned: no built-in
//               Claude Code tools (tools: []), no settings, Nova tools only.
//   - "oauth" : no key. The SDK drives the user's own `claude` binary, which
//               authenticates with their Claude Code login (Pro / Max /
//               Enterprise). Full Claude Code toolset + user/project settings
//               (skills, hooks, plugins) so it behaves like their terminal.
// In-process Nova tool wrappers round-trip editor calls through
// ws-server.js → main.js → Nova in both modes.
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
import { existsSync, realpathSync } from "fs";
import { spawn } from "child_process";
import { dirname, extname, join } from "path";
import { fileURLToPath } from "url";
import { WebSocketServer } from "ws";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { buildNovaToolsServer } from "./chat-tool-wrappers.mjs";
import { authorizeRequest, rejectUpgrade } from "./ws-auth.mjs";
import { listSessions, streamSessionTranscript } from "./list-sessions.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CHAT_UI_DIR = join(__dirname, "chat-ui");

// Last-resort model list for the chat picker, used only when neither the
// Anthropic /v1/models endpoint (SDK mode) nor Claude Code's own
// supportedModels() (both modes, via the user's `claude`) could be reached.
// Keep the newest / most capable first.
const FALLBACK_MODELS = [
  { id: "claude-fable-5-1",  label: "Fable 5.1" },
  { id: "claude-opus-5-5",   label: "Opus 5.5" },
  { id: "claude-sonnet-5",   label: "Sonnet 5" },
  { id: "claude-opus-4-8",   label: "Opus 4.8 (1M)" },
  { id: "claude-opus-4-7",   label: "Opus 4.7" },
  { id: "claude-sonnet-4-6", label: "Sonnet 4.6" },
  { id: "claude-haiku-4-5",  label: "Haiku 4.5" },
];

// Ask the Anthropic API which models this key can use, so the picker
// auto-discovers new models without a code change. SDK mode only — the
// endpoint needs an API key, so CLI/OAuth mode keeps the fallback list.
// Returns null on any failure so the caller keeps the fallback.
async function fetchModels(apiKey, log) {
  // Bound the request so a slow/offline network can't stall chat init —
  // init() awaits this before the HTTP server starts listening.
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 3000);
  try {
    const res = await fetch("https://api.anthropic.com/v1/models?limit=100", {
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      signal: ac.signal,
    });
    if (!res.ok) {
      log("warn", `chat: /v1/models returned ${res.status} — using fallback model list`);
      return null;
    }
    const body = await res.json();
    const rows = Array.isArray(body?.data) ? body.data : [];
    const models = rows
      .filter((m) => typeof m?.id === "string" && m.id.startsWith("claude-"))
      .map((m) => ({
        id: m.id,
        label: (m.display_name || m.id).replace(/^Claude\s+/, ""),
      }));
    return models.length ? models : null;
  } catch (err) {
    const why = err.name === "AbortError" ? "timed out" : err.message;
    log("warn", `chat: failed to fetch model list: ${why} — using fallback`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

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
 * @param {string}   opts.token          Shared secret required on /ws and /cli upgrades (see ws-auth.mjs)
 * @param {string}   opts.apiKey         Anthropic API key (already resolved)
 * @param {string}   opts.model          "claude-sonnet-5", etc.
 * @param {Function} opts.callNovaTool   async (toolName, args) → result (Phase 3)
 * @param {Function} opts.log            (level, msg, data?) → void
 */
export async function init(opts) {
  const { port, token = null, apiKey, model: initialModel = "claude-sonnet-5", cliPermissionMode = "acceptEdits", callNovaTool, log, claudePath, getBridgeInfo } = opts;
  if (!token) log("warn", "chat: no shared token configured — /ws and /cli are protected by Host/Origin checks only");

  // The currently-active model. Starts from the value `init()` was called
  // with (read by main.js from claudecode.chat.model), can be flipped at
  // runtime by a {type:"set_model"} message from the chat UI's picker.
  // Each user_message uses whatever is current at submission time, so the
  // user can A/B between Sonnet and Opus mid-conversation.
  let model = initialModel;

  // Auth mode — see the header comment. Both run the Agent SDK in
  // streaming input mode; they differ in credentials, toolset and settings.
  const chatMode = apiKey ? "sdk" : "oauth";
  if (chatMode === "sdk") {
    process.env.ANTHROPIC_API_KEY = apiKey;
    log("info", "chat: SDK mode (API key resolved) — Nova tools only, billed to the key");
  } else {
    log("info", "chat: OAuth mode (no API key) — driving the user's claude binary with their Claude Code login");
  }

  // Permission mode for the spawned Claude Code (setting
  // claudecode.chat.cliPermissionMode, kept under its historical key).
  // `default` now means "ask in the chat" thanks to canUseTool below —
  // it used to mean read-only because -p mode had nobody to ask.
  const PERMISSION_MODES = ["default", "acceptEdits", "bypassPermissions", "plan", "dontAsk"];
  const permissionMode = PERMISSION_MODES.includes(cliPermissionMode) ? cliPermissionMode : "acceptEdits";
  log("info", `chat: permission mode ${permissionMode}`);

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
    "explain-error":
      "Diagnose this error.\n\nThe selected text (or the user's next message if no selection) is a stack trace or error message. Walk through it:\n\n1. **What broke** — the actual failure, stripped of framework noise.\n2. **Where** — the file:line that's the root cause (not the deepest frame, the *responsible* one).\n3. **Why** — the underlying condition that made this happen.\n4. **Fix** — concrete code or config change. If multiple causes are possible, rank them by likelihood.\n\nIf the context lacks enough info to be sure, ask one targeted clarifying question rather than guess.",
    why:
      "Explain *why* the selected code exists, not what it does.\n\nFocus on intent, design decisions, and the constraints that shaped it:\n- What problem does this solve?\n- What alternative would have been simpler? Why isn't it good enough?\n- What invariants does this code maintain? What breaks if you remove it?\n- Are there comments, commit messages, or sibling code that hint at the rationale? (If you need to, use `getGitLog` or `workspaceSearch` to find context.)\n\nKeep it focused — if the code is mundane and the why is obvious, say so in one sentence rather than padding.",
    search:
      "Search the workspace for the user's query and summarize the relevant hits.\n\n1. Call `workspaceSearch` with the user's exact phrase (use `regex: false` for plain text, `regex: true` only if they typed a regex). Set `glob` if the user mentioned a file type or directory.\n2. Group the hits by file. For each group, show the file path and a short bulleted list of the lines (file:line — snippet).\n3. End with a one-sentence interpretation of what the hits suggest about the codebase.\n\nIf there are many hits, prioritize the ones that look like definitions / call sites over comments / test fixtures.",
    find:
      "Locate a symbol definition in the workspace.\n\nThe user's next message names a function / class / type / variable. Build a regex that matches its definition for the languages most likely in this workspace (e.g. JavaScript/TypeScript: `(function|const|class|interface|type|enum)\\s+<name>` ; Python: `(def|class)\\s+<name>` ; Go: `(func|type)\\s+<name>` ; Rust: `(fn|struct|enum|trait|impl)\\s+<name>`). Then call `workspaceSearch` with `regex: true` and that pattern.\n\nList each match as `<file>:<line>` with the matched line. If you find multiple definitions, mark which one is most likely the canonical implementation (usually the largest, or in src/lib, not tests).",
    plan:
      "Don't act on this request yet. First, break it into an ordered checklist of concrete steps.\n\nFor each step:\n- One sentence on what it accomplishes\n- The files / commands / decisions it involves\n- Anything it depends on from earlier steps\n\nEnd with: \"Reply OK to proceed, or tell me what to adjust.\" Then stop and wait — don't start executing until the user confirms.",
    recap:
      "Summarize the current conversation so far. Five bullets max:\n- The user's goal / topic\n- Key decisions or conclusions reached\n- Open questions still unresolved\n- Notable code / files touched\n- Suggested next step\n\nKeep it telegraphic — this is for the user to scan, not read.",
    spec:
      "Turn the current conversation into a formal specification, ready to drop into `docs/specs/` or a PR description.\n\nSections (use `##` headings, in this order):\n1. **Context** — what is the user trying to accomplish, in 2-3 sentences.\n2. **Problem** — the gap between today and the desired state.\n3. **Requirements** — functional (what it does) and non-functional (perf / security / a11y / etc.), as bulleted lists.\n4. **Out of scope** — explicit non-goals so reviewers don't expect them.\n5. **Acceptance criteria** — checklist of testable conditions that say \"this is done\".\n6. **Open questions** — anything we still owe a decision on.\n\nOutput as one self-contained markdown block. No conversational tone — write it the way you'd want to read it six months later.",
    readme:
      "Generate (or rewrite) a README for this project. First call `getWorkspaceFolders` to find the workspace root and look at what's there — package.json, pyproject.toml, Cargo.toml, etc. hint at the language and entry points; the directory layout hints at the architecture.\n\nProduce a README with these sections:\n- One-line tagline under the title.\n- **What it does** — 2-3 sentence pitch.\n- **Why** — the problem this solves.\n- **Install** — copy-pasteable commands.\n- **Quick start** — the minimum a new user runs to see something work.\n- **Configuration** — settings / env vars worth knowing.\n- **Architecture** (only if non-obvious) — 3-5 bullets on how the pieces fit.\n- **Contributing** — one paragraph pointer.\n- **License** — line.\n\nOutput inside one ```markdown block. Use the selected code or the active file's path to ground the examples — don't invent feature names.",
    "api-doc":
      "Extract the public API surface of the selected code (or the current file if there's no selection) and write reference documentation.\n\nFor each exported symbol (function, class, type, constant):\n- **Signature** — copy the declaration verbatim, including types.\n- **Summary** — one sentence on what it does.\n- **Parameters** — bulleted list with types and meaning (skip if the signature speaks for itself).\n- **Returns** — what comes back and when.\n- **Throws / errors** — failure modes worth knowing.\n- **Example** — the shortest realistic usage, in a code block.\n\nSkip internal / private symbols. Group exports under an `## Exports` heading. Output as one ```markdown block.",
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

  // ── Claude Code process ────────────────────────────────────────
  // Resolve the `claude` binary the SDK should drive. We prefer the user's
  // own install (their OAuth login, skills, plugins and hooks live there)
  // over the copy bundled inside the SDK; fall back to the bundle when the
  // user's binary can't be found.
  function resolveClaudeExecutable() {
    const bin = claudePath || "claude";
    try {
      if (bin.startsWith("/")) return existsSync(bin) ? realpathSync(bin) : null;
      const home = process.env.HOME || "";
      const dirs = [`${home}/.local/bin`, "/usr/local/bin", "/opt/homebrew/bin", ...(process.env.PATH || "").split(":")];
      for (const d of dirs) {
        if (!d) continue;
        const candidate = join(d, bin);
        if (existsSync(candidate)) return realpathSync(candidate);
      }
    } catch (_) {}
    return null;
  }
  const claudeExe = resolveClaudeExecutable();
  // No fallback: since v0.26.0 the bundle no longer ships the SDK's vendored
  // Claude Code binary (it was 214 MB of the 250 MB extension). The chat,
  // like the bridge and the terminal panel, needs the user's own install.
  const CLAUDE_MISSING_MSG =
    `Claude Code CLI not found ("${claudePath || "claude"}" is not on PATH). ` +
    "Install it (https://docs.anthropic.com/en/docs/claude-code) or point the " +
    "\"Claude CLI command\" project setting at the binary, then restart the bridge.";
  if (claudeExe) log("info", `chat: Claude Code executable ${claudeExe}`);
  else log("error", `chat: ${CLAUDE_MISSING_MSG}`);

  // Environment for the spawned process: inherit ours, but never let it
  // believe it is nested inside another Claude Code session (Nova may have
  // been launched from one), and never hand an API key to OAuth mode.
  function claudeEnv() {
    const env = { ...process.env };
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE_ENTRYPOINT;
    if (chatMode === "oauth") delete env.ANTHROPIC_API_KEY;
    return env;
  }

  // Ask the user's Claude Code which models it offers — the same list its
  // own /model picker shows, aliases resolved to canonical ids. Works with
  // the OAuth login (no API key needed). Spawns a short-lived idle session
  // (~0.7 s) purely for the control request; nothing is sent to a model.
  async function discoverModelsViaSdk() {
    if (!claudeExe) return null;
    let release;
    const gate = new Promise((r) => { release = r; });
    async function* idle() { await gate; }
    const abort = new AbortController();
    const timer = setTimeout(() => { try { abort.abort(); } catch (_) {} }, 8000);
    let q;
    try {
      q = query({ prompt: idle(), options: {
        cwd: process.env.CC_WORKSPACE || process.cwd(),
        env: claudeEnv(),
        pathToClaudeCodeExecutable: claudeExe,
        settingSources: [],
        tools: [],
        abortController: abort,
        stderr: () => {},
      } });
      // Drain the event stream in the background so the SDK's reader never
      // blocks; it ends when we abort below.
      const drain = (async () => { try { for await (const _ of q) { /* idle */ } } catch (_) {} })();
      const raw = await q.supportedModels();
      release(); abort.abort();
      await Promise.race([drain, new Promise((r) => setTimeout(r, 1500))]);
      return normalizeSdkModels(raw);
    } catch (err) {
      log("warn", `chat: supportedModels() failed: ${err.message} — using fallback model list`);
      try { release(); abort.abort(); } catch (_) {}
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  // ModelInfo[] → picker entries. Aliases ("default", "opus", "sonnet",
  // "haiku") resolve to the same canonical ids as explicit entries; keep
  // one row per canonical id, in Claude Code's order, and flag the one the
  // CLI calls "default" as recommended.
  function normalizeSdkModels(raw) {
    if (!Array.isArray(raw) || raw.length === 0) return null;
    const byId = new Map();
    let recommended = null;
    for (const m of raw) {
      const id = m?.resolvedModel || m?.value;
      if (typeof id !== "string" || !id) continue;
      if (m.value === "default") { recommended = id; continue; }
      const isAlias = m.value !== id;
      const existing = byId.get(id);
      if (!existing || (existing.isAlias && !isAlias)) {
        byId.set(id, { id, label: m.displayName || id.replace(/^claude-/, ""), description: m.description || "", isAlias });
      }
    }
    const models = [...byId.values()].map(({ isAlias, ...m }) => (
      m.id === recommended ? { ...m, label: `${m.label} · recommended` } : m
    ));
    // Claude Code lists its aliases first (opus, sonnet…); surface the one it
    // calls default at the top of the picker instead.
    const i = models.findIndex((m) => m.id === recommended);
    if (i > 0) models.unshift(...models.splice(i, 1));
    return models.length ? models : null;
  }

  // Model list that feeds the chat UI's picker, computed once and pushed
  // to every client in its `config` message.
  //   sdk   → Anthropic /v1/models (what the key can reach), else SDK, else fallback
  //   oauth → Claude Code's own list via supportedModels(), else fallback
  let availableModels = null;
  let modelsSource = "fallback";
  if (chatMode === "sdk") {
    availableModels = await fetchModels(apiKey, log);
    if (availableModels) modelsSource = "api";
  }
  if (!availableModels) {
    availableModels = await discoverModelsViaSdk();
    if (availableModels) modelsSource = "sdk";
  }
  if (!availableModels) availableModels = FALLBACK_MODELS;
  log("info", `chat: ${availableModels.length} models offered to the picker (source: ${modelsSource})`);

  // Extend PATH the way Nova's stripped subprocess PATH needs when spawning
  // the CLI by bare name (used by `claude agents --json` below).
  function spawnEnvForClaude() {
    const env = claudeEnv();
    const home = process.env.HOME || "";
    const extra = [`${home}/.local/bin`, "/usr/local/bin", "/opt/homebrew/bin"];
    env.PATH = [...new Set([...extra, ...(env.PATH || "").split(":")])].filter(Boolean).join(":");
    return env;
  }

  function describeResultError(ev) {
    if (Array.isArray(ev.errors) && ev.errors.length) return ev.errors.join("\n");
    if (typeof ev.error === "string" && ev.error) return ev.error;
    return ev.subtype || "query failed";
  }

  // One persistent Claude Code process per chat session.
  //
  // `push()` appends a user message to the async-generator prompt; the
  // process picks it up as its next turn. `interrupt()` stops the current
  // turn only. `close()` ends the process. Permission prompts arrive via
  // canUseTool → forwarded to the chat as `permission_request`, answered
  // with `permission_response` (allow / allow_always / deny).
  function startSession({ resume, send, getModel, onSessionId, onClosed }) {
    const queue = [];
    let waiter = null;
    let closed = false;
    let sessionId = resume || null;
    let turnsInFlight = 0;
    let interrupted = false;
    let textStreamed = false;   // deltas seen for the assistant message being built
    const pending = new Map();  // permission id → { resolve, toolInput, suggestions }

    async function* input() {
      while (!closed) {
        if (queue.length) yield queue.shift();
        else await new Promise((resolve) => { waiter = resolve; });
      }
    }
    function wake() { if (waiter) { const w = waiter; waiter = null; w(); } }

    const abort = new AbortController();
    const options = {
      model: getModel(),
      cwd: process.env.CC_WORKSPACE || process.cwd(),
      includePartialMessages: true,
      env: claudeEnv(),
      ...(claudeExe ? { pathToClaudeCodeExecutable: claudeExe } : {}),
      // OAuth mode = the user's terminal experience (all tools, their
      // settings). SDK mode = cost-tuned: no built-in tools, no settings.
      settingSources: chatMode === "oauth" ? ["user", "project"] : [],
      ...(chatMode === "oauth" ? {} : { tools: [] }),
      mcpServers: { nova: novaServer },
      allowedTools: allowedToolNames,
      permissionMode,
      ...(permissionMode === "bypassPermissions" ? { allowDangerouslySkipPermissions: true } : {}),
      canUseTool: (toolName, toolInput, ctx) => new Promise((resolve) => {
        const id = `perm_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const suggestions = Array.isArray(ctx?.suggestions) ? ctx.suggestions : [];
        pending.set(id, { resolve, toolInput, suggestions });
        send({ type: "permission_request", id, toolName, input: toolInput, canAlwaysAllow: suggestions.length > 0 });
        log("info", `chat: permission requested for ${toolName} (${id})`);
        if (ctx?.signal) {
          ctx.signal.addEventListener("abort", () => {
            if (pending.delete(id)) {
              resolve({ behavior: "deny", message: "Cancelled" });
              send({ type: "permission_resolved", id, behavior: "cancelled" });
            }
          }, { once: true });
        }
      }),
      abortController: abort,
      stderr: (data) => {
        const line = String(data).trim();
        if (line) log("debug", `claude stderr: ${line.slice(0, 300)}`);
      },
      ...(resume ? { resume } : {}),
    };

    const q = query({ prompt: input(), options });

    (async () => {
      try {
        for await (const ev of q) {
          switch (ev.type) {
            case "system":
              if (ev.subtype === "init") {
                sessionId = ev.session_id;
                if (onSessionId) onSessionId(sessionId);
                send({ type: "session_started", sessionId, model: ev.model ?? getModel(), mode: chatMode });
              }
              break;

            case "stream_event": {
              const e = ev.event;
              if (e?.type === "content_block_delta") {
                const d = e.delta;
                if (d?.type === "text_delta" && typeof d.text === "string") {
                  textStreamed = true;
                  send({ type: "assistant_text", chunk: d.text });
                } else if (d?.type === "thinking_delta" && typeof d.thinking === "string") {
                  send({ type: "assistant_thinking", chunk: d.thinking });
                }
              }
              break;
            }

            case "assistant": {
              // Committed blocks. Text already streamed as deltas is skipped;
              // tool_use only appears here (deltas don't carry tool input).
              for (const block of ev.message?.content ?? []) {
                if (block.type === "tool_use") {
                  send({ type: "assistant_tool_use", name: block.name, input: block.input || {} });
                } else if (block.type === "text" && block.text) {
                  if (textStreamed) textStreamed = false;
                  else send({ type: "assistant_text", chunk: block.text });
                }
              }
              break;
            }

            case "user": {
              for (const block of ev.message?.content ?? []) {
                if (block.type === "tool_result") {
                  const text = Array.isArray(block.content)
                    ? block.content.map((c) => c.text ?? "").join("")
                    : (block.content ?? "");
                  send({ type: "tool_result", name: block.name ?? "unknown", text, isError: !!block.is_error });
                }
              }
              break;
            }

            case "result": {
              turnsInFlight = Math.max(0, turnsInFlight - 1);
              textStreamed = false;
              const ok = ev.subtype === "success";
              send({
                type: "result",
                success: ok,
                cost: ev.total_cost_usd ?? null,
                tokens: ev.usage ? { input: ev.usage.input_tokens, output: ev.usage.output_tokens } : null,
                ...(ok ? {} : { error: interrupted ? "Interrupted" : describeResultError(ev) }),
              });
              interrupted = false;
              break;
            }
          }
        }
      } catch (err) {
        if (!closed) {
          log("error", `chat session error: ${err.message}`);
          send({ type: "error", message: err.name === "AbortError" ? "session aborted" : (err.message || String(err)) });
        }
      } finally {
        closed = true;
        wake();
        for (const [id, p] of pending) {
          p.resolve({ behavior: "deny", message: "Session closed" });
          send({ type: "permission_resolved", id, behavior: "cancelled" });
        }
        pending.clear();
        if (onClosed) onClosed();
      }
    })();

    return {
      get sessionId() { return sessionId; },
      get busy() { return turnsInFlight > 0; },
      push(userMessage) {
        queue.push(userMessage);
        turnsInFlight++;
        wake();
      },
      answerPermission(id, behavior, message) {
        const p = pending.get(id);
        if (!p) return false;
        pending.delete(id);
        if (behavior === "allow") {
          p.resolve({ behavior: "allow", updatedInput: p.toolInput });
        } else if (behavior === "allow_always") {
          p.resolve({ behavior: "allow", updatedInput: p.toolInput, updatedPermissions: p.suggestions });
        } else {
          p.resolve({ behavior: "deny", message: message || "Denied by the user in the Nova chat" });
        }
        log("info", `chat: permission ${id} → ${behavior}`);
        return true;
      },
      async interrupt() {
        if (!turnsInFlight) return;
        interrupted = true;
        try { await q.interrupt(); }
        catch (err) { log("warn", `chat: interrupt failed: ${err.message}`); }
      },
      async setModel(m) {
        try { await q.setModel(m); }
        catch (err) { log("warn", `chat: setModel failed: ${err.message}`); }
      },
      close() {
        if (closed) return;
        closed = true;
        wake();
        try { abort.abort(); } catch (_) {}
      },
    };
  }

  // ── HTTP server (static files) ─────────────────────────────────
  const httpServer = createServer(async (req, res) => {
    try {
      // Static assets don't need the token (the page itself carries it in
      // its URL), but a foreign Host/Origin is still refused — that's the
      // DNS-rebinding defense.
      const gate = authorizeRequest(req, { token, port, requireToken: false });
      if (!gate.ok) {
        log("warn", `chat http: refused ${req.method} ${req.url}: ${gate.reason}`);
        res.writeHead(gate.status, { "content-type": "text/plain" });
        return res.end(gate.reason);
      }
      let path = (req.url || "/").split("?")[0];
      if (path === "/") path = "/index.html";
      if (path.includes("..")) {
        res.writeHead(403); return res.end("Forbidden");
      }
      const filePath = join(CHAT_UI_DIR, path);
      const data = await readFile(filePath);
      const mime = MIME[extname(filePath)] || "application/octet-stream";
      res.writeHead(200, { "content-type": mime, "cache-control": "no-store, must-revalidate" });
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
  // Claude session ids currently driven by a connected chat client. The
  // bridge consults this (ownsSession) to tag hook events that originate
  // from the chat panel, so Nova skips notifications the chat already shows.
  const chatSessionIds = new Map();   // socket → session id

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
    if (path === "/cli") return; // owned by cli-session.mjs (its own listener gates it)
    if (path !== "/ws") {
      // Nobody owns this path — close it instead of leaving the socket hanging.
      rejectUpgrade(socket, 404, "no such endpoint");
      return;
    }
    // Host / Origin / token gate — see ws-auth.mjs for the threat model.
    const gate = authorizeRequest(req, { token, port });
    if (!gate.ok) {
      log("warn", `chat: refused /ws upgrade from ${req.socket.remoteAddress}: ${gate.reason}`);
      rejectUpgrade(socket, gate.status, gate.reason);
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });

  wss.on("connection", (socket, req) => {
    log("info", `chat: ws client connected from ${req.socket.remoteAddress}`);
    chatClients.add(socket);

    let session = null;           // live streaming-input session (started lazily)
    let currentSessionId = null;  // Claude session to resume when (re)starting

    const send = (msg) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
    };

    // Push the current config to the client immediately so the model
    // picker, mode badge, and theme override reflect reality before the
    // first session event.
    send({
      type: "config",
      defaultModel: model,
      models: availableModels,
      modelsSource,
      mode: chatMode,
      permissionMode,
      claudeAvailable: !!claudeExe,
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

    function ensureSession() {
      if (session) return session;
      const s = startSession({
        resume: currentSessionId,
        send,
        getModel: () => model,
        onSessionId: (id) => { currentSessionId = id; chatSessionIds.set(socket, id); },
        onClosed: () => { if (session === s) session = null; },
      });
      session = s;
      return s;
    }

    function dropSession() {
      if (session) { session.close(); session = null; }
    }

    socket.on("message", async (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString("utf8")); }
      catch { send({ type: "error", message: "invalid JSON" }); return; }

      if (msg.type === "abort") {
        // Stop the current turn; the process and its context survive.
        if (session) { session.interrupt(); log("info", "chat: turn interrupted"); }
        return;
      }

      if (msg.type === "set_model" && typeof msg.model === "string") {
        if (msg.model !== model) {
          log("info", `chat: switching model ${model} → ${msg.model}`);
          model = msg.model;
          if (session) session.setModel(model);
        }
        return;
      }

      if (msg.type === "permission_response" && typeof msg.id === "string") {
        const behavior = ["allow", "allow_always", "deny"].includes(msg.behavior) ? msg.behavior : "deny";
        if (!session || !session.answerPermission(msg.id, behavior, msg.message)) {
          log("warn", `chat: permission_response for unknown request ${msg.id}`);
        }
        return;
      }

      if (msg.type === "reset_session") {
        // /clear from the frontend — end the process so the next
        // user_message starts a brand-new conversation.
        if (currentSessionId) log("info", `chat: clearing session ${currentSessionId}`);
        dropSession();
        currentSessionId = null;
        chatSessionIds.delete(socket);
        send({ type: "session_cleared" });
        return;
      }

      if (msg.type === "list_sessions") {
        // Reply with sessions from ~/.claude/projects/<cwd>/ — the same
        // store both modes write to now that the SDK drives the CLI.
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

      if (msg.type === "list_live_sessions") {
        // Enumerate live claude sessions running on THIS machine via
        // `claude agents --json` (pid / cwd / status / sessionId).
        try {
          const child = spawn(claudeExe || claudePath || "claude", ["agents", "--json"], { env: spawnEnvForClaude() });
          let out = "";
          child.stdout.on("data", (c) => { out += c.toString("utf8"); });
          child.on("close", () => {
            let sessions = [];
            try { sessions = JSON.parse(out); } catch (_) {}
            if (!Array.isArray(sessions)) sessions = [];
            send({ type: "live_sessions", sessions });
          });
          child.on("error", (e) => {
            log("warn", `chat: agents --json failed: ${e.message}`);
            send({ type: "live_sessions", sessions: [] });
          });
        } catch (err) {
          send({ type: "live_sessions", sessions: [] });
        }
        return;
      }

      if (msg.type === "resume_session" && typeof msg.sessionId === "string") {
        // Attach to a past session: end the current process (if any) and
        // start the next one with `resume`. Replay the transcript first so
        // the user has visual continuity before their next prompt.
        dropSession();
        currentSessionId = msg.sessionId;
        chatSessionIds.set(socket, msg.sessionId);
        log("info", `chat: resuming session ${msg.sessionId}`);

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

      // Slash command + workspace context injection. Both optional — the
      // client decides per-message whether to use them.
      const prompt = await buildPrompt({
        text: msg.text,
        slashCommand: msg.slashCommand || null,
        injectContext: msg.injectContext === true,
      });

      // Multimodal — image attachments become `image` content blocks.
      // Streaming input mode accepts them in both auth modes.
      const attachments = Array.isArray(msg.attachments) ? msg.attachments : [];
      const content = attachments.length > 0
        ? [
            ...attachments.map((a) => ({
              type: "image",
              source: { type: "base64", media_type: a.mediaType || "image/png", data: a.data },
            })),
            { type: "text", text: prompt },
          ]
        : prompt;

      if (!claudeExe) {
        send({ type: "error", message: CLAUDE_MISSING_MSG });
        return;
      }

      // Queue the turn. If a turn is still running, the SDK processes this
      // one right after it — no "previous query still running" rejection.
      try {
        ensureSession().push({
          type: "user",
          message: { role: "user", content },
          parent_tool_use_id: null,
        });
      } catch (err) {
        log("error", `chat: failed to start session: ${err.message}`);
        send({ type: "error", message: err.message || String(err) });
      }
    });

    socket.on("close", () => {
      dropSession();
      chatClients.delete(socket);
      chatSessionIds.delete(socket);
      log("info", "chat: ws client disconnected");
    });

    socket.on("error", (err) => log("error", `chat ws socket error: ${err.message}`));
  });

  // ── Start listening ───────────────────────────────────────────
  // Retry on EADDRINUSE: a stale chat server from a previous Nova
  // session can still be holding the port for a second or two after
  // Nova relaunches. Rather than giving up (which left the chat dead
  // until a manual "Restart Bridge"), retry the bind a few times.
  await new Promise((resolve, reject) => {
    const MAX_ATTEMPTS = 8;     // ~8 × 750ms ≈ 6s total
    const RETRY_DELAY_MS = 750;
    let attempts = 0;

    const onError = (err) => {
      if (err && err.code === "EADDRINUSE" && attempts < MAX_ATTEMPTS) {
        attempts++;
        log("warn", `chat: port ${port} busy (EADDRINUSE) — retry ${attempts}/${MAX_ATTEMPTS} in ${RETRY_DELAY_MS}ms`);
        setTimeout(tryListen, RETRY_DELAY_MS);
        return;
      }
      reject(err);
    };

    const tryListen = () => {
      httpServer.removeListener("error", onError);
      httpServer.once("error", onError);
      httpServer.listen(port, "127.0.0.1", () => {
        httpServer.removeListener("error", onError);
        log("info", `chat server listening on http://127.0.0.1:${port}/` +
          (attempts ? ` (after ${attempts} retr${attempts === 1 ? "y" : "ies"})` : ""));
        resolve();
      });
    };

    tryListen();
  });

  return {
    port,
    httpServer, // exposed so cli-session can attach a sibling /cli WSS
    // True when a connected chat client is driving this Claude session id.
    // ws-server uses it to tag hook events that originate from the chat
    // panel so Nova does not double-notify what the chat UI already shows.
    ownsSession(sessionId) {
      if (!sessionId) return false;
      for (const id of chatSessionIds.values()) if (id === sessionId) return true;
      return false;
    },
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
