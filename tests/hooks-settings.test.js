#!/usr/bin/env node
/**
 * hooks.js settings.json surgery — install / re-install / uninstall / corrupt file.
 *
 * hooks.js runs inside Nova (JavaScriptCore) and edits ~/.claude/settings.json
 * through nova.fs. This test loads it under Node with a minimal `nova` stub
 * backed by the real fs and a scratch CLAUDE_CONFIG_DIR, then checks that:
 *   - install adds our async relay entry on all 9 events, shell-quotes the
 *     bundle path, keeps foreign hooks and unrelated settings, backs up once
 *   - re-install is idempotent (no duplicates, backup untouched)
 *   - uninstall removes exactly our entries, leaves foreign hooks, drops
 *     emptied event keys
 *   - a settings.json that is not valid JSON makes install throw without
 *     touching the file
 *
 * Run: node tests/hooks-settings.test.js
 */

"use strict";
const fs = require("fs");
const path = require("path");
const os = require("os");

const SCRIPTS = path.resolve(__dirname, "..", "claudecode-nova.novaextension", "Scripts");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-hooks-settings-"));
const settingsFile = path.join(dir, "settings.json");
const FOREIGN = "/Users/x/.config/iterm2/cc-status";
const original = {
  permissions: { allow: ["Bash(ls *)"] },
  hooks: {
    SessionStart: [{ hooks: [{ type: "command", command: FOREIGN }] }],
    Stop: [{ hooks: [{ type: "command", command: FOREIGN }] }],
  },
};
fs.writeFileSync(settingsFile, JSON.stringify(original, null, 2));

// --- minimal nova stub: just what hooks.js + util.js touch -----------------
class File {
  constructor(p, mode) { this.p = p; this.mode = mode; this.buf = ""; }
  read() { return fs.readFileSync(this.p, "utf8"); }
  write(s) { this.buf += s; }
  close() { if (this.mode === "w") fs.writeFileSync(this.p, this.buf); }
}
global.nova = {
  environment: { HOME: os.homedir(), CLAUDE_CONFIG_DIR: dir },
  path: { join: path.join },
  extension: { path: "/Applications/Ext Path With Space.novaextension" },
  fs: {
    stat: (p) => (fs.existsSync(p) ? fs.statSync(p) : null),
    open: (p, mode) => new File(p, mode),
    mkdir: (p) => fs.mkdirSync(p),
    copy: (a, b) => fs.copyFileSync(a, b),
  },
  config: { get: () => null, set: () => {} },
  notifications: { add: () => Promise.resolve(null) },
};
global.NotificationRequest = function() {};

require(path.join(SCRIPTS, "state.js"));
require(path.join(SCRIPTS, "registry.js"));
require(path.join(SCRIPTS, "util.js"));
const H = require(path.join(SCRIPTS, "hooks.js"));

const readSettings = () => JSON.parse(fs.readFileSync(settingsFile, "utf8"));
const backupFile = settingsFile + ".claudecode-nova.bak";
const isRelay = (h) => h.command.includes("hook-relay.sh");
let ok = true;
function check(cond, msg) {
  console.log((cond ? "PASS" : "FAIL") + ": " + msg);
  if (!cond) ok = false;
}

check(H.checkInstalled() === false, "not installed initially");

H.installHooks();
let s = readSettings();
check(H.HOOK_EVENTS.every((ev) => s.hooks[ev].some((g) => g.hooks.some((h) => isRelay(h) && h.async === true))),
  "install: all 9 events carry our async relay entry");
check(s.hooks.SessionStart.some((g) => g.hooks.some((h) => h.command === FOREIGN)),
  "install: foreign SessionStart hook preserved");
check(s.permissions.allow[0] === "Bash(ls *)", "install: unrelated settings preserved");
check(s.hooks.SessionStart.find((g) => g.hooks.some(isRelay)).hooks[0].command
  === "/bin/sh '/Applications/Ext Path With Space.novaextension/Scripts/hook-relay.sh'",
  "install: relay path is shell-quoted");
check(fs.existsSync(backupFile), "install: backup created");
const backup1 = fs.readFileSync(backupFile, "utf8");
check(H.checkInstalled() === true, "installed-detection true after install");

H.installHooks();
s = readSettings();
check(s.hooks.Stop.filter((g) => g.hooks.some(isRelay)).length === 1, "re-install: no duplicate relay entries");
check(fs.readFileSync(backupFile, "utf8") === backup1, "re-install: backup not overwritten");

const removed = H.uninstallHooks();
s = readSettings();
check(removed === 9, "uninstall: removed exactly 9 entries (got " + removed + ")");
check(!JSON.stringify(s).includes("hook-relay.sh"), "uninstall: no relay entries left");
check(s.hooks.SessionStart.length === 1 && s.hooks.Stop.length === 1
  && s.hooks.SessionStart[0].hooks[0].command === FOREIGN, "uninstall: foreign hooks untouched");
check(!("PreToolUse" in s.hooks) && !("SessionEnd" in s.hooks), "uninstall: emptied event keys deleted");
check(H.checkInstalled() === false, "installed-detection false after uninstall");

fs.writeFileSync(settingsFile, "{ not json");
let threw = false;
try { H.installHooks(); } catch (_) { threw = true; }
check(threw && fs.readFileSync(settingsFile, "utf8") === "{ not json",
  "corrupt settings.json: install throws and leaves the file untouched");

if (!ok) process.exit(1);
console.log("PASS: hooks settings surgery");
