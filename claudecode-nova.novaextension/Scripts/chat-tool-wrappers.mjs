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
