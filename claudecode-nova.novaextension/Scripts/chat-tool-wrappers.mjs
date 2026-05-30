// chat-tool-wrappers.mjs — in-process SDK tools that wrap the 12 Nova MCP
// tools registered in ws-server.js.
//
// Each wrapper :
//   1. Declares a Zod schema matching the JSON Schema in ws-server.js
//   2. Calls `callNovaTool(mcpToolName, args)` which round-trips through
//      ws-server.js → main.js → Nova editor and resolves with the MCP-shaped
//      payload (already formatted by formatToolResultPayload in ws-server.js)
//   3. Returns that payload to the SDK
//
// The SDK exposes these as `mcp__nova__<name>` ; the chat UI strips the
// prefix for display.

import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

/**
 * Build an SDK MCP server exposing all Nova editor operations.
 *
 * @param {Object}   deps
 * @param {Function} deps.callNovaTool  async (mcpToolName, args) → MCP payload
 * @param {Function} deps.log           (level, msg) → void
 */
export function buildNovaToolsServer({ callNovaTool, log }) {
  // Helper — every wrapper has the same shape, so factor it.
  // `mcpName` is the name registered in ws-server.js (which main.js dispatches on).
  function wrap(mcpName, description, schema) {
    return tool(
      `nova_${mcpName}`,
      description,
      schema,
      async (args) => {
        log("debug", `chat → nova.${mcpName}`, args);
        try {
          return await callNovaTool(mcpName, args);
        } catch (err) {
          return {
            content: [{ type: "text", text: `Error calling ${mcpName}: ${err.message}` }],
            isError: true,
          };
        }
      },
    );
  }

  const tools = [
    // ── File / editor navigation ─────────────────────────────────
    wrap(
      "openFile",
      "Open a file in the Nova editor. Optionally select a text range by start/end pattern. Use this to show the user a file you're discussing.",
      {
        filePath:          z.string().describe("Path to the file to open (absolute or workspace-relative)"),
        preview:           z.boolean().optional().describe("Open in preview tab"),
        startText:         z.string().optional().describe("Text pattern marking selection start"),
        endText:           z.string().optional().describe("Text pattern marking selection end"),
        selectToEndOfLine: z.boolean().optional().describe("Extend selection to end of line"),
        makeFrontmost:     z.boolean().optional().describe("Make the file the active editor tab"),
      },
    ),

    wrap(
      "openDiff",
      "Open a git-style diff view in Nova showing proposed changes. Use this when proposing an edit so the user can accept or reject. Blocks until the user decides.",
      {
        old_file_path:     z.string().describe("Path to the original file"),
        new_file_path:     z.string().describe("Path the new file will have (often same as old)"),
        new_file_contents: z.string().describe("Full new content"),
        tab_name:          z.string().describe("Name shown in the diff tab"),
      },
    ),

    // ── Selection / current state ────────────────────────────────
    wrap(
      "getCurrentSelection",
      "Get the user's current text selection in the active editor. Use this when the user refers to 'this code' or asks about something they're highlighting.",
      {},
    ),

    wrap(
      "getLatestSelection",
      "Get the most recent text selection across editors, even if not currently in focus.",
      {},
    ),

    wrap(
      "getOpenEditors",
      "List all currently open editor tabs in Nova, with their file paths and active state.",
      {},
    ),

    wrap(
      "getWorkspaceFolders",
      "Get the workspace folder paths currently open in Nova. Use this to understand the project root.",
      {},
    ),

    // ── Document state ───────────────────────────────────────────
    wrap(
      "checkDocumentDirty",
      "Check whether a file has unsaved changes in Nova.",
      {
        filePath: z.string().describe("Path to the file"),
      },
    ),

    wrap(
      "saveDocument",
      "Save a file in Nova (writes unsaved changes to disk).",
      {
        filePath: z.string().describe("Path to the file to save"),
      },
    ),

    // ── Diagnostics ──────────────────────────────────────────────
    wrap(
      "getDiagnostics",
      "Get language diagnostics (errors, warnings) from Nova. If uri is omitted, returns diagnostics for all open files.",
      {
        uri: z.string().optional().describe("File URI (file:// scheme) — omit for all files"),
      },
    ),

    // ── Tab management ───────────────────────────────────────────
    wrap(
      "close_tab",
      "Close a specific tab in Nova by its name.",
      {
        tab_name: z.string().describe("Name of the tab to close"),
      },
    ),

    wrap(
      "closeAllDiffTabs",
      "Close all currently-open diff tabs in Nova at once.",
      {},
    ),

    // ── Code execution (Jupyter-style — rarely used in chat) ─────
    wrap(
      "executeCode",
      "Execute code on the current Jupyter kernel (only meaningful in a notebook context).",
      {
        code: z.string().describe("Code to execute"),
      },
    ),

    // ── Git diff (drives /commit, /changelog, /pr) ───────────────
    wrap(
      "getGitDiff",
      "Run git diff in the workspace and return the raw output. Use this before writing commit messages, changelog entries, or PR descriptions so the copy is grounded in actual changes.",
      {
        staged:   z.boolean().optional().describe("Pass --cached to diff staged changes only"),
        range:    z.string().optional().describe("Git range like main..HEAD or v0.14.1..HEAD"),
        stat:     z.boolean().optional().describe("Pass --stat for a summary instead of full hunks"),
        maxBytes: z.number().int().optional().describe("Cap output size (default 65536). Truncated output sets truncated:true."),
      },
    ),

    // ── Git log (drives /changelog, /pr) ─────────────────────────
    wrap(
      "getGitLog",
      "Run git log and return the commit list. Use with a range (e.g. last-tag..HEAD or main..HEAD) to ground changelog entries and PR descriptions in real commit messages.",
      {
        range:    z.string().optional().describe("Git range, e.g. v0.14.2..HEAD or main..HEAD"),
        limit:    z.number().int().optional().describe("Max commits returned (default 50)"),
        format:   z.enum(["oneline", "subject", "full"]).optional().describe("oneline = `<sha> <subject>`, subject = one subject per line, full = subject + body (defaults to oneline)"),
        maxBytes: z.number().int().optional().describe("Cap output size (default 65536)"),
      },
    ),

    // ── Workspace search (drives /search, /find) ─────────────────
    wrap(
      "workspaceSearch",
      "Recursive grep across the workspace, skipping .git/node_modules/dist/etc. Use this to locate code by literal text (/search) or by symbol-definition regex (/find). Returns `{file, line, text}` records.",
      {
        query:    z.string().describe("Text or regex to search for"),
        regex:    z.boolean().optional().describe("true = extended regex (-E), false = fixed string (-F, default)"),
        glob:     z.string().optional().describe("File include pattern, e.g. *.ts or *.{js,ts}"),
        maxHits:  z.number().int().optional().describe("Stop after N matches (default 200)"),
        maxBytes: z.number().int().optional().describe("Cap stdout (default 262144)"),
      },
    ),

    // ── Apply edit at selection ──────────────────────────────────
    wrap(
      "applyEditAtSelection",
      "Replace the currently-selected text in the active Nova editor with new content. Use this for self-contained, no-review rewrites where a full diff would be overkill (small refactor, rename, fix). Fails if there is no active editor or no selection. For multi-file or larger changes, use the diff flow instead.",
      {
        text: z.string().describe("Replacement text. Trailing newline is stripped unless trimTrailingNewline is false."),
        trimTrailingNewline: z.boolean().optional().describe("If false, keep a trailing \\n in the replacement (default true)."),
      },
    ),

    // ── Run shell command ────────────────────────────────────────
    wrap(
      "runShellCommand",
      "Spawn `/bin/sh -c <command>` in the workspace and capture stdout/stderr. Use this for ad-hoc shell ops (npm scripts, git checkout/commit/push, build steps, file inspection). The command runs unsandboxed with the user's privileges — be explicit about what you're doing in your messages. Output is capped per stream and the process is SIGTERMed after timeoutMs.",
      {
        command:   z.string().describe("Shell command line, e.g. `npm test` or `git checkout -b feature/foo`."),
        cwd:       z.string().optional().describe("Override the working directory (defaults to workspace root)."),
        timeoutMs: z.number().int().optional().describe("Terminate after N milliseconds (default 30000)."),
        maxBytes:  z.number().int().optional().describe("Cap captured output per stream (default 65536)."),
      },
    ),

    // ── Write file ───────────────────────────────────────────────
    wrap(
      "writeFile",
      "Create or overwrite a file at the given path. Prefer this over `runShellCommand` with heredocs — it's safer (no shell escaping pitfalls) and reports byte counts. Use mode `wx` for safe-create that fails if the file exists.",
      {
        path:       z.string().describe("Absolute path, or path relative to the workspace root."),
        content:    z.string().describe("Text content to write."),
        mode:       z.enum(["w", "a", "wx"]).optional().describe("`w` overwrites (default), `a` appends, `wx` fails if the file already exists."),
        createDirs: z.boolean().optional().describe("Create missing parent directories first (like `mkdir -p`)."),
      },
    ),

    // ── File exists ──────────────────────────────────────────────
    wrap(
      "fileExists",
      "Stat a path and return existence + type + size + mtime. Use before `writeFile` with mode `w` to confirm you're not silently clobbering something the user cares about, or before `openFile` to give a clean error.",
      {
        path: z.string().describe("Absolute path, or path relative to the workspace root."),
      },
    ),

    // ── Notify ───────────────────────────────────────────────────
    wrap(
      "notify",
      "Show a non-blocking Nova notification. Use for completion signals on long-running tasks (build done, tests passed) or to surface a warning without interrupting the chat flow. Don't spam — one notification per task.",
      {
        title: z.string().describe("Headline shown in the notification banner."),
        body:  z.string().optional().describe("Secondary text under the title."),
        type:  z.enum(["info", "warning", "error"]).optional().describe("Severity hint — controls the title prefix icon (default `info`)."),
      },
    ),

    // ── Ask user ─────────────────────────────────────────────────
    wrap(
      "askUser",
      "Block and ask the user a question via a native Nova modal. With `options` you get a button-choice action panel (returns selectedIndex + selectedValue). Without `options`, you get a free-text input palette (returns text). Use sparingly — prefer asking in-chat unless the question is a clear binary or short text-input decision blocking the next step.",
      {
        question:     z.string().describe("Prompt text shown to the user."),
        options:      z.array(z.string()).min(2).max(4).optional().describe("2–4 button labels for the action panel. Omit for free-text input."),
        placeholder:  z.string().optional().describe("Placeholder text for free-text input mode."),
        defaultValue: z.string().optional().describe("Pre-filled value for free-text input mode."),
      },
    ),

    // ── List directory ───────────────────────────────────────────
    wrap(
      "listDirectory",
      "List entries in a directory via `nova.fs.listdir`. Returns name + isFile + isDirectory + isSymlink + size for each entry. Recursive walk skips `.git` / `node_modules` / `dist` etc. Faster than `runShellCommand('ls')` for browsing project structure.",
      {
        path:          z.string().describe("Absolute path, or relative to the workspace root."),
        recursive:     z.boolean().optional().describe("Walk subdirectories (skipping common heavy dirs). Default false."),
        maxEntries:    z.number().int().optional().describe("Cap on total entries returned (default 500). Sets truncated:true if hit."),
        includeHidden: z.boolean().optional().describe("Include dot-files (default false)."),
      },
    ),

    // ── Insert at cursor ─────────────────────────────────────────
    wrap(
      "insertAtCursor",
      "Insert text at the active editor's cursor without replacing the selection. Distinct from `applyEditAtSelection` (which replaces). If the editor has a selection, text is inserted at the selection start — selection is preserved.",
      {
        text: z.string().describe("Text to insert at the cursor."),
      },
    ),

    // ── Replace in file ──────────────────────────────────────────
    wrap(
      "replaceInFile",
      "Find-and-replace inside a specific file's content (on disk, not via the editor). Literal substitution by default; pass regex:true with optional flags for pattern matching. Useful for targeted refactors where a full diff review would be overkill but `applyEditAtSelection` is too narrow.",
      {
        path:            z.string().describe("Absolute path or workspace-relative."),
        find:            z.string().describe("Text to find (literal, or JS RegExp source if regex:true)."),
        replace:         z.string().describe("Replacement text. Use `$&` to reference the match when regex:true."),
        regex:           z.boolean().optional().describe("Treat `find` as a JS RegExp (default false)."),
        flags:           z.string().optional().describe("Regex flags (default 'g'; 'g' is force-added if missing)."),
        maxReplacements: z.number().int().optional().describe("Cap on number of substitutions (default unlimited)."),
      },
    ),

    // ── Clipboard write ──────────────────────────────────────────
    wrap(
      "clipboardWrite",
      "Put text on the macOS clipboard via `nova.clipboard.writeText`. Useful when generating a snippet the user will paste outside Nova (a Slack message, a wiki page, a different terminal).",
      {
        text: z.string().describe("Text to copy to the clipboard."),
      },
    ),

    // ── Open new text document ───────────────────────────────────
    wrap(
      "openNewTextDocument",
      "Open a fresh unsaved Nova document with optional initial content + syntax hint. Use for scratch drafts (spec being authored, command list being assembled) before deciding whether and where to save with `writeFile`.",
      {
        content: z.string().optional().describe("Initial document body."),
        syntax:  z.string().optional().describe("Nova syntax identifier (e.g. 'markdown', 'typescript', 'javascript', 'json')."),
      },
    ),

    // ── Get open documents ───────────────────────────────────────
    wrap(
      "getOpenDocuments",
      "Return every TextDocument Nova has open, including those without an active editor (background tabs). Differs from `getOpenEditors` (visible editors only). Use to know what files are loaded across Nova even if not focused.",
      {},
    ),
  ];

  return {
    server: createSdkMcpServer({
      name: "nova",
      version: "0.6.0",
      tools,
    }),
    // The SDK exposes each as mcp__nova__<name> — needed for allowedTools
    toolNames: tools.map((t) => `mcp__nova__${t.name}`),
  };
}
