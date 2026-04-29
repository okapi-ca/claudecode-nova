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

console.log("PASS: extension.json valid, version " + manifest.version + " matches CHANGELOG");
