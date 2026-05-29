// list-sessions.mjs — read Claude Code's per-workspace session log
// dir (~/.claude/projects/<encoded-cwd>/*.jsonl), parse just enough
// metadata for a "Resume…" picker, and return the list sorted by
// recency. Shares the encoding convention with
// sessions-tree-provider.js (the Nova sidebar).
//
// Each .jsonl entry's filename (sans extension) IS the session_id —
// that's what `claude --resume <id>` consumes.

import { readdir, stat, open } from "fs/promises";
import { join } from "path";
import { homedir } from "os";
import { createInterface } from "readline";
import { createReadStream } from "fs";

const MAX_SCAN_LINES = 200;       // bound the preview parse cost
const PREVIEW_MAX_CHARS = 80;

function encodedCwd(cwd) {
  // Claude Code encodes the absolute cwd into a single dir name by
  // replacing every "/" with "-" (so the leading slash becomes "-").
  return (cwd || "").replace(/\//g, "-");
}

function sessionDirFor(cwd) {
  if (!cwd) return null;
  return join(homedir(), ".claude", "projects", encodedCwd(cwd));
}

// Read the first real user message from a session jsonl (skipping
// slash-command caveats). Also captures the git branch if it shows
// up before that. Returns {preview, gitBranch}; preview is "" if
// the session has no user-typed message yet.
async function readSessionPreview(path) {
  let fh;
  try { fh = await open(path, "r"); }
  catch { return { preview: "", gitBranch: null }; }

  let buf = "";
  let lineCount = 0;
  let preview = "";
  let gitBranch = null;
  try {
    const stream = fh.createReadStream({ encoding: "utf8" });
    for await (const chunk of stream) {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1 && lineCount < MAX_SCAN_LINES && !preview) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        lineCount++;
        let obj;
        try { obj = JSON.parse(line); } catch { continue; }

        if (!gitBranch && typeof obj.gitBranch === "string" && obj.gitBranch) {
          gitBranch = obj.gitBranch;
        }
        if (obj.type !== "user") continue;
        const text = extractUserText(obj);
        if (!text) continue;
        if (text.startsWith("<local-command") || text.startsWith("<command-")) continue;
        preview = truncate(text.replace(/\s+/g, " ").trim(), PREVIEW_MAX_CHARS);
      }
      if (preview || lineCount >= MAX_SCAN_LINES) break;
    }
  } catch (_) {
    /* swallow; preview stays empty */
  } finally {
    try { await fh.close(); } catch (_) {}
  }
  return { preview, gitBranch };
}

function extractUserText(event) {
  const msg = event.message;
  if (!msg) return "";
  const content = msg.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    for (const c of content) {
      if (c && typeof c === "object" && typeof c.text === "string") return c.text;
    }
  }
  return "";
}

// Concatenate every text block in an assistant message. The CLI stores
// each turn as a single `assistant` event with a content array
// containing text blocks (and tool_use blocks we skip here).
function extractAssistantText(event) {
  const msg = event.message;
  if (!msg) return "";
  const content = msg.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((c) => c && c.type === "text" && typeof c.text === "string")
    .map((c) => c.text)
    .join("");
}

/**
 * Stream a session's turns back to a callback in the order they
 * were recorded. Emits user/assistant text messages AND
 * tool_use / tool_result events so the replay reflects the full
 * shape of the past conversation, not just its text spine.
 *
 * Each emit is one of:
 *   { kind: "message", role: "user"|"assistant", text, ts }
 *   { kind: "tool_use", name, input, ts }
 *   { kind: "tool_result", name, text, isError, ts }
 */
export async function streamSessionTranscript(cwd, sessionId, onEvent) {
  const dir = sessionDirFor(cwd);
  if (!dir) return;
  const path = join(dir, sessionId + ".jsonl");

  let stream;
  try { stream = createReadStream(path, { encoding: "utf8" }); }
  catch { return; }

  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj;
    try { obj = JSON.parse(trimmed); } catch { continue; }
    const ts = obj.timestamp || null;

    if (obj.type === "user") {
      // A "user" record can carry either a plain text turn OR
      // tool_result blocks (when Claude's previous turn ran a tool
      // and the runtime fed the result back as a user message).
      const content = obj.message?.content;
      if (typeof content === "string") {
        if (!content.startsWith("<local-command") && !content.startsWith("<command-")) {
          onEvent({ kind: "message", role: "user", text: content, ts });
        }
      } else if (Array.isArray(content)) {
        for (const block of content) {
          if (!block || typeof block !== "object") continue;
          if (block.type === "tool_result") {
            const text = Array.isArray(block.content)
              ? block.content.map((c) => c?.text ?? "").join("")
              : (block.content ?? "");
            onEvent({
              kind: "tool_result",
              name: block.name || "tool",
              text: typeof text === "string" ? text : JSON.stringify(text),
              isError: !!block.is_error,
              ts,
            });
          } else if (typeof block.text === "string") {
            if (!block.text.startsWith("<local-command") && !block.text.startsWith("<command-")) {
              onEvent({ kind: "message", role: "user", text: block.text, ts });
            }
          }
        }
      }
    } else if (obj.type === "assistant") {
      const content = obj.message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (!block) continue;
          if (block.type === "text" && typeof block.text === "string") {
            onEvent({ kind: "message", role: "assistant", text: block.text, ts });
          } else if (block.type === "tool_use") {
            onEvent({ kind: "tool_use", name: block.name, input: block.input || {}, ts });
          }
        }
      } else if (typeof content === "string") {
        onEvent({ kind: "message", role: "assistant", text: content, ts });
      }
    }
  }
}

function truncate(s, n) {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}

/**
 * List sessions for the given workspace cwd, sorted by mtime desc.
 * Returns at most `limit` entries (default 30) — newer first.
 *
 * Each entry: { sessionId, mtimeMs, preview, gitBranch }.
 */
export async function listSessions(cwd, { limit = 30 } = {}) {
  const dir = sessionDirFor(cwd);
  if (!dir) return [];

  let entries;
  try { entries = await readdir(dir); }
  catch { return []; }

  const records = [];
  for (const name of entries) {
    if (!name.endsWith(".jsonl")) continue;
    const sessionId = name.slice(0, -".jsonl".length);
    const full = join(dir, name);
    let st;
    try { st = await stat(full); }
    catch { continue; }
    records.push({ sessionId, full, mtimeMs: st.mtimeMs });
  }

  records.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const sliced = records.slice(0, limit);

  // Parse previews only for the top N entries (saves IO when the
  // user has hundreds of past sessions).
  for (const r of sliced) {
    const { preview, gitBranch } = await readSessionPreview(r.full);
    r.preview = preview;
    r.gitBranch = gitBranch;
    delete r.full;
  }
  return sliced;
}
