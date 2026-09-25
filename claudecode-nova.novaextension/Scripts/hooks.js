// hooks.js — Claude Code hook relay: per-session live state for the sidebar,
// notifications for "waiting on you" / failures, and the install / uninstall
// of our relay into ~/.claude/settings.json.
//
// Runs in Nova's JavaScriptCore runtime (CommonJS require, no Node built-ins).
// Nova's require() does NOT support circular dependencies, so this module
// never requires its siblings: it attaches its exports to the shared
// registry (R.Hooks) and dereferences R.<Name>.fn at call time.
//
// How events get here: Claude Code runs Scripts/hook-relay.sh (async command
// hook) on the session-state events; the script POSTs the event JSON to the
// bridge's /hook endpoint; ws-server.js forwards it to us as a `hook_event`
// message. Nothing in this path blocks Claude, and a stopped bridge simply
// means the events are dropped.

const S = require("./state.js");
const R = require("./registry.js");

// Events we subscribe to. Enough to derive working / waiting / idle without
// drowning in traffic (no MessageDisplay, no SubagentStart/Stop).
const HOOK_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PermissionRequest",
  "Notification",
  "Stop",
  "StopFailure",
  "SessionEnd",
];

// Substring that identifies our entries in settings.json — lets install()
// replace a stale path and uninstall() find its own entries and nothing else.
const RELAY_MARKER = "hook-relay.sh";

const EDIT_TOOLS = { Edit: true, Write: true, MultiEdit: true, NotebookEdit: true };

// Notification types that mean Claude is blocked on the human.
const WAITING_NOTIFICATIONS = {
  permission_prompt: true,
  elicitation_dialog: true,
  elicitation_url_dialog: true,
  agent_needs_input: true,
};

const SNIPPET_MAX = 120;
const STALE_SESSION_MS = 6 * 60 * 60 * 1000;   // drop sessions that vanished without SessionEnd
const SESSIONS_REFRESH_DEBOUNCE_MS = 250;

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

function claudeConfigDir() {
  return nova.environment["CLAUDE_CONFIG_DIR"]
    || nova.path.join(nova.environment["HOME"], ".claude");
}

function settingsPath() {
  return nova.path.join(claudeConfigDir(), "settings.json");
}

function relayPath() {
  return nova.path.join(nova.extension.path, "Scripts", "hook-relay.sh");
}

// Invoke through /bin/sh so the bundle's executable bit never matters
// (Nova's Library install does not promise to preserve it).
function relayCommand() {
  return "/bin/sh " + R.Util.shellQuote(relayPath());
}

// ---------------------------------------------------------------------------
// settings.json read / write
// ---------------------------------------------------------------------------

// Returns { settings, exists } or throws if the file exists but is not JSON —
// we never overwrite a file we could not parse.
function readSettings() {
  var path = settingsPath();
  var stat = null;
  try { stat = nova.fs.stat(path); } catch (_) {}
  if (!stat) return { settings: {}, exists: false };
  var f = nova.fs.open(path, "r");
  var raw;
  try { raw = f.read() || ""; } finally { try { f.close(); } catch (_) {} }
  if (!raw.trim()) return { settings: {}, exists: true };
  return { settings: JSON.parse(raw), exists: true };
}

function writeSettings(settings, existed) {
  var dir = claudeConfigDir();
  var path = settingsPath();
  var stat = null;
  try { stat = nova.fs.stat(dir); } catch (_) {}
  if (!stat) nova.fs.mkdir(dir);

  // One-time backup of the pre-existing file. Never overwritten: it is the
  // "what did it look like before this extension touched it" snapshot.
  if (existed) {
    var backup = path + ".claudecode-nova.bak";
    var hasBackup = null;
    try { hasBackup = nova.fs.stat(backup); } catch (_) {}
    if (!hasBackup) {
      try { nova.fs.copy(path, backup); } catch (err) {
        console.warn("Claude Code Bridge: settings backup failed:", err.message);
      }
    }
  }

  var f = nova.fs.open(path, "w");
  try { f.write(JSON.stringify(settings, null, 2) + "\n"); }
  finally { try { f.close(); } catch (_) {} }
}

function isRelayHook(h) {
  return !!(h && typeof h.command === "string" && h.command.indexOf(RELAY_MARKER) !== -1);
}

function groupHasRelay(group) {
  return !!(group && Array.isArray(group.hooks) && group.hooks.some(isRelayHook));
}

function hooksInstalledIn(settings) {
  var hooks = settings && settings.hooks;
  if (!hooks || typeof hooks !== "object") return false;
  return HOOK_EVENTS.every(function(ev) {
    return Array.isArray(hooks[ev]) && hooks[ev].some(groupHasRelay);
  });
}

// Strip every relay entry from a hooks map (mutates). Returns the count.
function removeRelayEntries(hooks) {
  var removed = 0;
  Object.keys(hooks).forEach(function(ev) {
    if (!Array.isArray(hooks[ev])) return;
    var kept = [];
    hooks[ev].forEach(function(group) {
      if (!group || !Array.isArray(group.hooks)) { kept.push(group); return; }
      var before = group.hooks.length;
      group.hooks = group.hooks.filter(function(h) { return !isRelayHook(h); });
      removed += before - group.hooks.length;
      if (group.hooks.length > 0) kept.push(group);
    });
    if (kept.length > 0) hooks[ev] = kept;
    else delete hooks[ev];
  });
  return removed;
}

function installHooks() {
  var read = readSettings();
  var settings = read.settings;
  if (!settings.hooks || typeof settings.hooks !== "object") settings.hooks = {};
  // Replace rather than append: a previous install may point at an older
  // extension path.
  removeRelayEntries(settings.hooks);
  HOOK_EVENTS.forEach(function(ev) {
    if (!Array.isArray(settings.hooks[ev])) settings.hooks[ev] = [];
    settings.hooks[ev].push({
      hooks: [{
        type: "command",
        command: relayCommand(),
        // async: Claude never waits on us. timeout is moot for async hooks
        // but documents the intent should someone flip the flag.
        async: true,
        timeout: 5,
      }],
    });
  });
  writeSettings(settings, read.exists);
  S.hooksInstalled = true;
}

function uninstallHooks() {
  var read = readSettings();
  var settings = read.settings;
  var removed = 0;
  if (settings.hooks && typeof settings.hooks === "object") {
    removed = removeRelayEntries(settings.hooks);
    if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
  }
  if (removed > 0) writeSettings(settings, read.exists);
  S.hooksInstalled = false;
  return removed;
}

function checkInstalled() {
  try {
    S.hooksInstalled = hooksInstalledIn(readSettings().settings);
  } catch (_) {
    S.hooksInstalled = false;
  }
  return S.hooksInstalled;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function installHooksHandler() {
  try {
    installHooks();
    R.Util.showNotification(
      "Hooks installed",
      "Claude Code now reports session status to Nova (" + HOOK_EVENTS.length + " events in "
        + settingsPath() + ").\nTakes effect for sessions started from now on."
    );
  } catch (err) {
    console.error("Claude Code Bridge: hook install failed:", err.message);
    R.Util.showNotification(
      "Hook install failed",
      err.message + "\nNothing was written. Check that " + settingsPath() + " is valid JSON."
    );
  }
}

function uninstallHooksHandler() {
  try {
    var removed = uninstallHooks();
    R.Util.showNotification(
      "Hooks removed",
      removed > 0
        ? removed + " relay entr" + (removed === 1 ? "y" : "ies") + " removed from " + settingsPath() + "."
        : "No Claude Code Bridge hooks were present in " + settingsPath() + "."
    );
  } catch (err) {
    console.error("Claude Code Bridge: hook uninstall failed:", err.message);
    R.Util.showNotification("Hook removal failed", err.message);
  }
}

// One-time offer after activation. "Later" asks again next activation;
// "Don't ask again" is remembered in the extension's global config.
function maybeOfferInstall() {
  // Runs from a timer after activate(): an uncaught throw here would take the
  // whole extension down, so everything is fenced.
  try {
    if (nova.config.get("claudecode.hooks.offerDismissed") === true) return;
    if (checkInstalled()) return;

    var req = new NotificationRequest("claudecode-hooks-offer");
    req.title = "Claude Code: see session status in Nova?";
    req.body = "Install Claude Code hooks so the Recent Sessions sidebar shows each session as working, "
      + "waiting for you, or idle — including sessions started in a terminal. "
      + "Adds " + HOOK_EVENTS.length + " async hook entries to " + settingsPath() + ".";
    req.actions = ["Install", "Later", "Don't ask again"];
    Promise.resolve(nova.notifications.add(req)).then(function(reply) {
      if (!reply) return;
      if (reply.actionIdx === 0) installHooksHandler();
      else if (reply.actionIdx === 2) nova.config.set("claudecode.hooks.offerDismissed", true);
    }).catch(function(err) {
      console.warn("Claude Code Bridge: hooks offer dismissed:", err && err.message);
    });
  } catch (err) {
    console.error("Claude Code Bridge: hooks offer failed:", err && err.message);
  }
}

// ---------------------------------------------------------------------------
// Event handling — the per-session state machine
// ---------------------------------------------------------------------------

function snippet(text) {
  if (typeof text !== "string") return null;
  var t = text.replace(/\s+/g, " ").trim();
  if (!t) return null;
  return t.length > SNIPPET_MAX ? t.slice(0, SNIPPET_MAX - 1) + "…" : t;
}

function pruneStaleSessions(now) {
  Object.keys(S.claudeSessions).forEach(function(id) {
    if (now - S.claudeSessions[id].updatedAt > STALE_SESSION_MS) delete S.claudeSessions[id];
  });
}

function scheduleSessionsRefresh() {
  if (S.claudeSessionsRefreshTimer) return;
  S.claudeSessionsRefreshTimer = setTimeout(function() {
    S.claudeSessionsRefreshTimer = null;
    R.Sidebar.refreshSessionsSidebar();
  }, SESSIONS_REFRESH_DEBOUNCE_MS);
}

function shortId(id) {
  return typeof id === "string" ? id.slice(0, 8) : "?";
}

// `fromChat` is set by ws-server.js when the event's session_id is the chat
// panel's own Claude session: the chat UI already shows permission cards
// and turn results there, so we keep the sidebar state but stay quiet.
function handleHookEvent(ev, fromChat) {
  try {
    handleHookEventUnsafe(ev, fromChat);
  } catch (err) {
    console.error("Claude Code Bridge: hook event handling failed:", err && err.message, err && err.stack || "");
  }
}

function handleHookEventUnsafe(ev, fromChat) {
  if (!ev || typeof ev !== "object" || typeof ev.session_id !== "string") return;
  var now = Date.now();
  pruneStaleSessions(now);

  var id = ev.session_id;
  var s = S.claudeSessions[id];
  if (!s) {
    s = S.claudeSessions[id] = {
      sessionId: id,
      cwd: ev.cwd || null,
      state: "idle",
      tool: null,
      lastMessage: null,
      lastError: null,
      model: null,
      permissionMode: null,
      startedAt: now,
      updatedAt: now,
      fromChat: !!fromChat,
    };
  }
  s.updatedAt = now;
  if (ev.cwd) s.cwd = ev.cwd;
  if (ev.permission_mode) s.permissionMode = ev.permission_mode;
  if (fromChat) s.fromChat = true;

  var prevState = s.state;
  var activityDirty = false;

  switch (ev.hook_event_name) {
    case "SessionStart":
      s.state = "idle";
      if (typeof ev.model === "string") s.model = ev.model;
      s.lastError = null;
      break;

    case "UserPromptSubmit":
      s.state = "working";
      s.tool = null;
      s.lastError = null;
      break;

    case "PreToolUse":
      s.state = "working";
      s.tool = ev.tool_name || null;
      break;

    case "PermissionRequest":
      s.state = "waiting";
      if (ev.tool_name) s.tool = ev.tool_name;
      break;

    case "Notification": {
      var t = ev.notification_type;
      if (WAITING_NOTIFICATIONS[t]) s.state = "waiting";
      else if (t === "idle_prompt" || t === "agent_completed") { s.state = "idle"; s.tool = null; }
      break;
    }

    case "PostToolUse":
      // A tool finished, so any permission prompt for it was answered.
      s.state = "working";
      s.tool = null;
      if (EDIT_TOOLS[ev.tool_name] && ev.tool_input && typeof ev.tool_input.file_path === "string") {
        R.Activity.logActivity("claude_edited", {
          filePath: ev.tool_input.file_path,
          tool: ev.tool_name,
          sessionId: id,
        });
        activityDirty = true;
      }
      break;

    case "Stop":
      s.state = "idle";
      s.tool = null;
      s.lastMessage = snippet(ev.last_assistant_message);
      R.Activity.logActivity("claude_stopped", { snippet: s.lastMessage, sessionId: id });
      activityDirty = true;
      // Claude may have committed or switched branches during the turn.
      try { R.Sidebar.refreshGitBranch(); } catch (_) {}
      if (!s.fromChat && nova.config.get("claudecode.hooks.notifyOnStop") === true) {
        R.Util.showNotification(
          "Claude finished (" + shortId(id) + ")",
          s.lastMessage || "Turn complete."
        );
      }
      break;

    case "StopFailure":
      s.state = "error";
      s.tool = null;
      s.lastError = (ev.error_type || "error") + (ev.error_message ? ": " + ev.error_message : "");
      R.Activity.logActivity("claude_failed", { errorType: ev.error_type || null, sessionId: id });
      activityDirty = true;
      if (!s.fromChat) {
        R.Util.showNotification("Claude turn failed (" + shortId(id) + ")", s.lastError);
      }
      break;

    case "SessionEnd":
      delete S.claudeSessions[id];
      break;

    default:
      break;
  }

  if (s.state === "waiting" && prevState !== "waiting" && !s.fromChat
      && nova.config.get("claudecode.hooks.notifyWaiting") !== false) {
    R.Util.showNotification(
      "Waiting for you (" + shortId(id) + ")",
      "Claude needs your input" + (s.tool ? " — " + s.tool : "") + "."
    );
  }

  scheduleSessionsRefresh();
  if (activityDirty) R.Sidebar.refreshActivitySidebar();
}

R.Hooks = Object.assign(R.Hooks || {}, {
  HOOK_EVENTS,
  handleHookEvent,
  installHooks,
  uninstallHooks,
  checkInstalled,
  installHooksHandler,
  uninstallHooksHandler,
  maybeOfferInstall,
  settingsPath,
  relayPath,
});
module.exports = R.Hooks;
