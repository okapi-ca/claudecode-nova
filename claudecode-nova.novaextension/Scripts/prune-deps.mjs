#!/usr/bin/env node
// prune-deps.mjs — trims Scripts/node_modules down to what the extension
// actually executes. Runs as the npm `postinstall` hook and can be re-run
// by hand (`node prune-deps.mjs`). Idempotent.
//
// Why: Nova packages the .novaextension directory as-is, so everything
// under node_modules ships to every user via the Extension Library. Before
// this script the bundle weighed ~250 MB, 214 MB of which was the Claude
// Code binary vendored by @anthropic-ai/claude-agent-sdk-darwin-arm64 —
// dead weight since v0.25.0, because the chat always drives the user's own
// `claude` through options.pathToClaudeCodeExecutable (the SDK only falls
// back to the vendored binary when that option is missing). The remainder
// was mostly TypeScript declarations, source maps, C++ sources and tests.
//
// What survives must keep these working: ws-server.js (node core only),
// chat-session.mjs (@anthropic-ai/claude-agent-sdk + peers, ws),
// cli-session.mjs (node-pty prebuild for darwin-arm64), chat-tool-wrappers
// (zod). tests/validate-manifest.js checks the result before publishing.

import { readdirSync, rmSync, statSync, existsSync, chmodSync } from "fs";
import { join, dirname, basename, extname } from "path";
import { fileURLToPath } from "url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "node_modules");
if (!existsSync(ROOT)) { console.log("prune-deps: no node_modules — nothing to do"); process.exit(0); }

let removedBytes = 0, removedCount = 0;
function rm(p) {
  try {
    const size = dirSize(p);
    rmSync(p, { recursive: true, force: true });
    removedBytes += size; removedCount++;
  } catch (_) {}
}
function dirSize(p) {
  try {
    const st = statSync(p);
    if (!st.isDirectory()) return st.size;
    let total = 0;
    for (const e of readdirSync(p)) total += dirSize(join(p, e));
    return total;
  } catch (_) { return 0; }
}

// 1. Whole packages / trees we never load at runtime.
const WHOLE = [
  // Vendored Claude Code binaries for every platform — see header.
  ...readdirSync(join(ROOT, "@anthropic-ai"), { withFileTypes: true })
    .filter((d) => d.name.startsWith("claude-agent-sdk-"))
    .map((d) => join(ROOT, "@anthropic-ai", d.name)),
  // node-pty build inputs; only lib/ + prebuilds/darwin-arm64 are used.
  join(ROOT, "node-pty", "third_party"),
  join(ROOT, "node-pty", "deps"),
  join(ROOT, "node-pty", "src"),
  join(ROOT, "node-pty", "scripts"),
  join(ROOT, "node-pty", "binding.gyp"),
  // npm's CLI shims — Nova's validator refuses symlinks in the bundle.
  join(ROOT, ".bin"),
  // TypeScript sources shipped next to compiled output.
  join(ROOT, "zod", "src"),
  join(ROOT, "@anthropic-ai", "sdk", "src"),
];
for (const p of WHOLE) if (existsSync(p)) rm(p);

// node-pty prebuilds: keep darwin-arm64 only (Nova is macOS; Apple Silicon).
const prebuilds = join(ROOT, "node-pty", "prebuilds");
if (existsSync(prebuilds)) {
  for (const d of readdirSync(prebuilds)) if (d !== "darwin-arm64") rm(join(prebuilds, d));
  const helper = join(prebuilds, "darwin-arm64", "spawn-helper");
  if (existsSync(helper)) { try { chmodSync(helper, 0o755); } catch (_) {} } // ships without +x
}

// 2. File-level sweep: declarations, source maps, docs, tests, examples.
const DROP_EXT = new Set([".map"]);
const DROP_SUFFIX = [".d.ts", ".d.mts", ".d.cts"];
const DROP_MD = /\.(md|markdown)$/i;
const KEEP_MD = /^(LICEN[CS]E|COPYING|NOTICE)/i;
const DROP_DIRS = new Set(["test", "tests", "__tests__", "docs", "doc", "examples", "example", ".github"]);

function sweep(dir) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (DROP_DIRS.has(e.name)) { rm(p); continue; }
      sweep(p);
    } else if (e.isFile()) {
      const name = e.name;
      if (DROP_EXT.has(extname(name)) ||
          DROP_SUFFIX.some((s) => name.endsWith(s)) ||
          (DROP_MD.test(name) && !KEEP_MD.test(name))) {
        rm(p);
      }
    }
  }
}
sweep(ROOT);

const left = dirSize(ROOT);
console.log(`prune-deps: removed ${removedCount} entries (${(removedBytes / 1048576).toFixed(1)} MB); node_modules is now ${(left / 1048576).toFixed(1)} MB`);
