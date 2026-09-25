/**
 * Claude Code Bridge for Nova
 *
 * Main extension entry point. This file:
 *   1. Spawns the Node.js WebSocket server helper (ws-server.js)
 *   2. Communicates with it via JSON lines over stdin/stdout
 *   3. Maps MCP tool calls to Nova editor APIs
 *   4. Tracks editor selection and broadcasts changes
 *   5. Provides sidebar UI and commands
 *   6. Checks the Claude Code CLI for updates (manual + 24h auto)
 */

const S = require("./state.js");
const R = require("./registry.js");

// Load every module once. Each attaches its exports to the registry under
// its own name (R.Bridge, R.Tools, …); nothing here depends on load order.
require("./util.js");
require("./activity.js");
require("./sidebar.js");
require("./selection.js");
require("./tools.js");
require("./chat.js");
require("./bridge.js");
require("./launch.js");
require("./updates.js");
require("./hooks.js");

exports.activate = function() {
  console.log("Claude Code Bridge: activate() called");

  try {
    S.disposables.push(
      nova.commands.register("claudecode.start", R.Bridge.startBridge),
      nova.commands.register("claudecode.stop", R.Bridge.stopBridge),
      nova.commands.register("claudecode.restart", R.Bridge.restartBridge),
      nova.commands.register("claudecode.sendSelection", R.Selection.sendSelectionToContext),
      nova.commands.register("claudecode.addFile", R.Selection.addCurrentFile),
      nova.commands.register("claudecode.rotateChatToken", R.Chat.rotateChatTokenHandler),
      nova.commands.register("claudecode.status", R.Bridge.showStatus),
      nova.commands.register("claudecode.launchClaude", R.Launch.launchClaude),
      nova.commands.register("claudecode.activityClick", R.Sidebar.activityClickHandler),
      nova.commands.register("claudecode.activityClear", R.Sidebar.activityClearHandler),
      nova.commands.register("claudecode.diffAccept", R.Sidebar.diffAcceptHandler),
      nova.commands.register("claudecode.diffReject", R.Sidebar.diffRejectHandler),
      nova.commands.register("claudecode.diffShowDetails", R.Sidebar.diffShowDetailsHandler),
      nova.commands.register("claudecode.sidebarRefresh", R.Sidebar.sidebarRefreshHandler),
      nova.commands.register("claudecode.sessionsRefresh", R.Sidebar.sessionsRefreshHandler),
      nova.commands.register("claudecode.resumeSession", R.Sidebar.resumeSessionHandler),
      nova.commands.register("claudecode.checkForUpdates", function() { R.Updates.checkForUpdates(false); }),
      nova.commands.register("claudecode.openChat", R.Chat.openChatHandler),
      nova.commands.register("claudecode.setChatApiKey", R.Chat.setChatApiKeyHandler),
      nova.commands.register("claudecode.clearChatApiKey", R.Chat.clearChatApiKeyHandler),
      nova.commands.register("claudecode.installHooks", R.Hooks.installHooksHandler),
      nova.commands.register("claudecode.uninstallHooks", R.Hooks.uninstallHooksHandler),
    );
    console.log("Claude Code Bridge: commands registered");
  } catch (err) {
    console.error("Claude Code Bridge: failed to register commands:", err.message);
    return;
  }

  // Restore the persisted activity log (best-effort) before any UI renders,
  // so reopening Nova doesn't wipe the user's recent context.
  R.Activity.loadActivityLog();

  // Pre-build the activity sidebars so they render immediately
  // (placeholder text) instead of staying blank until the first event.
  R.Sidebar.ensureActivitySidebars();
  R.Sidebar.startActivityRefreshTimer();
  R.Sidebar.startGitBranchRefresh();

  const autoStart = nova.config.get("claudecode.autoStart");
  if (autoStart !== false) {
    // Chat key resolution may need an `op read` round-trip, so startBridge is
    // now async. Fire-and-forget — no caller awaits the return.
    R.Bridge.startBridge().catch((err) => {
      console.error("Claude Code Bridge: startBridge() failed:", err.message, err.stack || "");
      R.Util.showNotification("Error", `Failed to start bridge: ${err.message}`);
    });
  }

  // Fire-and-forget: never block activate() on a network round-trip.
  R.Updates.maybeAutoCheckUpdates();

  // One-time offer to wire Claude Code's hooks into the bridge (session
  // status in the sidebar). Delayed so it lands after the "Ready" toast.
  setTimeout(function() { R.Hooks.maybeOfferInstall(); }, 4000);

  console.log("Claude Code Bridge: activation complete");
};

exports.deactivate = function() {
  console.log("Claude Code Bridge: deactivating…");
  R.Sidebar.stopActivityRefreshTimer();
  R.Sidebar.stopGitBranchRefresh();
  R.Activity.flushActivityLog();
  R.Bridge.stopBridge();
  for (const d of S.disposables) {
    try { d.dispose(); } catch (_) {}
  }
  S.disposables = [];
};
