#!/usr/bin/env node
/**
 * Static validation of claudecode-nova.novaextension/extension.json.
 *
 * Catches:
 *   - Invalid JSON
 *   - Missing required Nova manifest fields
 *   - Version drift between extension.json and CHANGELOG.md
 *   - Empty repository field (Panic marketplace expects it)
 *   - Referenced script files that don't exist on disk
 */

"use strict";
const fs = require("fs");
const path = require("path");

const REQUIRED_FIELDS = [
  "identifier", "name", "organization", "description",
  "version", "categories", "main", "min_runtime",
];

const root = path.resolve(__dirname, "..");
const extDir = path.join(root, "claudecode-nova.novaextension");
const manifestPath = path.join(extDir, "extension.json");
const changelogPath = path.join(extDir, "CHANGELOG.md");

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}

let manifest;
try {
  manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
} catch (err) {
  fail("extension.json is not valid JSON: " + err.message);
}

for (const field of REQUIRED_FIELDS) {
  if (manifest[field] === undefined || manifest[field] === "" ||
      (Array.isArray(manifest[field]) && manifest[field].length === 0)) {
    fail("extension.json missing required field \"" + field + "\"");
  }
}

if (!manifest.repository) {
  fail("extension.json repository field is empty (required for marketplace listing)");
}

if (!/^\d+\.\d+\.\d+$/.test(manifest.version)) {
  fail("extension.json version \"" + manifest.version + "\" is not semver (X.Y.Z)");
}

// Files referenced by the manifest must exist
const mainFile = path.join(extDir, manifest.main);
if (!fs.existsSync(mainFile)) {
  fail("manifest.main points to missing file: " + manifest.main);
}

// Companion scripts that ship with the extension
const requiredScripts = [
  "Scripts/ws-server.js",
  "Scripts/call-bridge.js",
  "Scripts/chat-session.mjs",
  "Scripts/cli-session.mjs",
  "Scripts/ws-auth.mjs",
  "Scripts/prune-deps.mjs",
];
for (const rel of requiredScripts) {
  if (!fs.existsSync(path.join(extDir, rel))) {
    fail("expected script missing: " + rel);
  }
}

// Version consistency with CHANGELOG: the topmost "## X.Y.Z" must match manifest.version
let changelog;
try {
  changelog = fs.readFileSync(changelogPath, "utf8");
} catch (err) {
  fail("CHANGELOG.md unreadable: " + err.message);
}

const m = changelog.match(/^## (\d+\.\d+\.\d+)/m);
if (!m) {
  fail("CHANGELOG.md has no \"## X.Y.Z\" version heading");
}
if (m[1] !== manifest.version) {
  fail("version drift — extension.json says " + manifest.version +
       " but the latest CHANGELOG entry is " + m[1]);
}

// Bundle hygiene — only when node_modules is present (local / pre-publish;
// CI checks out the repo without it). Nova ships the directory as-is, so
// anything left here goes to every user. Scripts/prune-deps.mjs (npm
// postinstall) is supposed to have removed all of this.
const nm = path.join(extDir, "Scripts", "node_modules");
if (fs.existsSync(nm)) {
  const problems = [];
  const anthropicDir = path.join(nm, "@anthropic-ai");
  if (fs.existsSync(anthropicDir)) {
    for (const d of fs.readdirSync(anthropicDir)) {
      if (d.startsWith("claude-agent-sdk-")) problems.push("vendored Claude Code binary still present: @anthropic-ai/" + d + " (~214 MB)");
    }
  }
  if (fs.existsSync(path.join(nm, ".bin"))) problems.push("node_modules/.bin present (symlinks break `nova extension validate`)");
  const prebuilds = path.join(nm, "node-pty", "prebuilds");
  if (fs.existsSync(prebuilds)) {
    for (const d of fs.readdirSync(prebuilds)) if (d !== "darwin-arm64") problems.push("node-pty prebuild for another platform: " + d);
  }
  for (const rel of ["node-pty/third_party", "node-pty/deps", "zod/src"]) {
    if (fs.existsSync(path.join(nm, rel))) problems.push("build-time tree still present: " + rel);
  }
  // Sample the file-level sweep: any .map or .d.ts left means prune didn't run.
  let stray = 0;
  (function walk(dir, depth) {
    if (depth > 6 || stray > 0) return;
    let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (/\.(map|d\.ts)$/.test(e.name)) { stray++; problems.push("unpruned file: " + path.relative(nm, p)); return; }
    }
  })(nm, 0);
  if (problems.length) {
    fail("Scripts/node_modules is not pruned — run `cd claudecode-nova.novaextension/Scripts && node prune-deps.mjs`:\n  - " + problems.join("\n  - "));
  }
  const requiredDeps = ["@anthropic-ai/claude-agent-sdk/sdk.mjs", "ws/package.json", "zod/package.json", "node-pty/lib/index.js", "node-pty/prebuilds/darwin-arm64/spawn-helper"];
  for (const rel of requiredDeps) {
    if (!fs.existsSync(path.join(nm, rel))) fail("runtime dependency missing after prune: " + rel);
  }
  console.log("PASS: Scripts/node_modules is pruned (no vendored claude binary, no .bin, darwin-arm64 only)");
}

console.log("PASS: extension.json valid, version " + manifest.version + " matches CHANGELOG");
