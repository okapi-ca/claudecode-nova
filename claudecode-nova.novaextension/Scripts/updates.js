// updates.js — Claude Code CLI version check + update / install flows, version sidebar state.
//
// Split out of the former 3 500-line main.js (v0.28.0). Runs in Nova's
// JavaScriptCore runtime (CommonJS require, no Node built-ins). Nova's
// require() does NOT support circular dependencies (it recurses until
// "Maximum call stack size exceeded"), so modules never require each other:
// each one attaches its exports to the shared registry (R.<Name>) at the
// bottom, and cross-module calls dereference R.<Name>.fn at call time.

const S = require("./state.js");
const R = require("./registry.js");
const UpdateCheck = require("./update-check.js");

//
// Three entry points feed the same pipeline:
//   1. activate() → maybeAutoCheckUpdates() — silent, throttled to 24h.
//   2. Command "Claude Code: Check for Updates" → checkForUpdates(false).
//   3. Sidebar click on the version row → checkForUpdates(false).
//
// `silent=true` suppresses all notifications EXCEPT the "update available"
// one — that's the whole point of the daily auto-check.

function maybeAutoCheckUpdates() {
  // Hydrate the sidebar from the cached version BEFORE deciding to hit npm.
  // Without this, when the 24h throttle blocks the network call, versionState
  // stays at "unknown" and the sidebar shows "version unknown" until the next
  // manual check — even though we already know the version from disk.
  const lastSeen = nova.config.get("claudecode.updateCheck.lastSeenVersion");
  const lastCheckedAt = nova.config.get("claudecode.updateCheck.lastCheckedAt") || null;
  if (lastSeen) {
    S.versionState.state = "installed";
    S.versionState.currentVersion = lastSeen;
    S.versionState.lastCheckedAt = lastCheckedAt;
    R.Sidebar.refreshVersionSidebar();
  }

  if (nova.config.get("claudecode.updateCheck.autoCheck") === false) return;
  if (lastCheckedAt && Date.now() - lastCheckedAt < S.UPDATE_CHECK_INTERVAL_MS) return;
  checkForUpdates(true).catch(function(err) {
    console.warn("Claude Code Bridge: auto-check failed:", err.message);
  });
}

async function checkForUpdates(silent) {
  const claudeCommand = nova.workspace.config.get("claudecode.claudeCommand") || "claude";
  const channel = nova.config.get("claudecode.updateCheck.channel") || "stable";
  S.versionState.channel = channel;

  if (!silent) {
    S.versionState.state = "checking";
    S.versionState.message = null;
    R.Sidebar.refreshVersionSidebar();
  }

  let current;
  try {
    current = await UpdateCheck.getCurrentVersion(claudeCommand);
  } catch (err) {
    console.error("Claude Code Bridge: getCurrentVersion failed:", err.message);
    S.versionState.state = "error";
    S.versionState.message = err.message;
    R.Sidebar.refreshVersionSidebar();
    if (!silent) R.Util.showNotification("Update Check Failed", err.message);
    persistLastChecked();
    return;
  }

  if (current.state === "not_installed") {
    S.versionState.state = "not_installed";
    S.versionState.currentVersion = null;
    S.versionState.message = "Claude Code CLI was not found on PATH.";
    R.Sidebar.refreshVersionSidebar();
    presentNotInstalled(silent);
    persistLastChecked();
    return;
  }

  if (current.state === "unknown") {
    S.versionState.state = "unknown";
    S.versionState.currentVersion = null;
    S.versionState.message = current.error || current.raw || "Unparsable version output.";
    R.Sidebar.refreshVersionSidebar();
    if (!silent) {
      R.Util.showNotification("Version Unknown",
        "Could not parse `claude --version` output: " + S.versionState.message);
    }
    persistLastChecked();
    return;
  }

  S.versionState.currentVersion = current.version;

  let latest;
  try {
    latest = await UpdateCheck.getLatestVersion(channel);
  } catch (err) {
    S.versionState.state = "error";
    S.versionState.message = err.message;
    R.Sidebar.refreshVersionSidebar();
    if (!silent) R.Util.showNotification("Update Check Failed", err.message);
    persistLastChecked();
    return;
  }

  S.versionState.latestVersion = latest.version;
  const cmp = UpdateCheck.semverCompare(current.version, latest.version);
  persistLastChecked();

  if (cmp === null) {
    S.versionState.state = "unknown";
    S.versionState.message = "Could not compare versions (" + current.version + " vs " + latest.version + ").";
    R.Sidebar.refreshVersionSidebar();
    return;
  }

  if (cmp >= 0) {
    S.versionState.state = "up_to_date";
    S.versionState.message = null;
    R.Sidebar.refreshVersionSidebar();
    if (!silent) {
      R.Util.showNotification("Up to Date", "Claude Code is up to date (v" + current.version + ").");
    }
    return;
  }

  // Update available — always notify, even on silent auto-check.
  S.versionState.state = "update_available";
  S.versionState.message = "Update available: v" + current.version + " → v" + latest.version;
  R.Sidebar.refreshVersionSidebar();
  presentUpdateAvailable(current, latest);
}

function presentUpdateAvailable(current, latest) {
  const req = new NotificationRequest("claudecode-update-available");
  req.title = "Claude Code Update Available";
  req.body = "v" + current.version + " → v" + latest.version + ".\nUpdate will stop and restart the bridge.";
  req.actions = ["Update Now", "Release Notes", "Later"];

  nova.notifications.add(req).then(function(response) {
    if (response.actionIdx === 0) {
      const method = UpdateCheck.detectInstallMethod(current.path);
      runUpdateFlow(method);
    } else if (response.actionIdx === 1) {
      const url = "https://github.com/anthropics/claude-code/releases/tag/v" + latest.version;
      try { nova.openURL(url); }
      catch (err) {
        nova.clipboard.writeText(url);
        R.Util.showNotification("Release Notes", "URL copied to clipboard: " + url);
      }
    }
    // "Later" → no-op; user can re-check via the sidebar or command.
  });
}

async function presentNotInstalled(silent) {
  if (silent && nova.config.get("claudecode.updateCheck.suppressNotInstalled") === true) {
    return;
  }

  const npmOk = !silent && (await UpdateCheck.isNpmAvailable());

  const req = new NotificationRequest("claudecode-not-installed");
  req.title = "Claude Code CLI Not Found";
  req.body = "The Claude Code CLI is not on PATH. The bridge runs without it, but you'll need it to launch Claude from Nova.";
  req.actions = ["Install Guide", "Configure Path"];
  if (npmOk) req.actions.push("Install via npm");
  if (silent) req.actions.push("Don't Show Again");

  nova.notifications.add(req).then(function(response) {
    const action = req.actions[response.actionIdx];
    if (action === "Install Guide") {
      const url = "https://docs.anthropic.com/claude-code/install";
      try { nova.openURL(url); }
      catch (_) {
        nova.clipboard.writeText(url);
        R.Util.showNotification("Install Guide", "URL copied to clipboard: " + url);
      }
    } else if (action === "Configure Path") {
      try { nova.workspace.openConfig(nova.extension.identifier); }
      catch (err) {
        R.Util.showNotification("Open Settings", "Could not open extension settings: " + err.message);
      }
    } else if (action === "Install via npm") {
      runInstallFlow();
    } else if (action === "Don't Show Again") {
      nova.config.set("claudecode.updateCheck.suppressNotInstalled", true);
    }
  });
}

async function runUpdateFlow(method) {
  if (S.updateInProgress) {
    R.Util.showNotification("Update In Progress", "An update is already running.");
    return;
  }
  S.updateInProgress = true;

  const wasRunning = !!S.serverProcess;
  if (wasRunning) {
    R.Bridge.stopBridge();
    await R.Util.delay(500); // give the OS a moment to release the port
  }

  R.Util.showNotification("Updating", "Updating Claude Code… the bridge will restart automatically.");
  const claudeCommand = nova.workspace.config.get("claudecode.claudeCommand") || "claude";

  let result;
  try {
    result = await UpdateCheck.runUpdate(method, claudeCommand);
  } catch (err) {
    console.error("Claude Code Bridge: update threw:", err.message);
    result = { success: false, stderr: err.message };
  }

  S.updateInProgress = false;

  if (result.success) {
    // Re-probe the new version so the sidebar reflects reality.
    try {
      const current = await UpdateCheck.getCurrentVersion(claudeCommand);
      if (current.state === "installed") {
        S.versionState.currentVersion = current.version;
        S.versionState.state = "up_to_date";
        S.versionState.message = null;
        R.Sidebar.refreshVersionSidebar();
      }
    } catch (_) {}

    R.Util.showNotification("Update Complete",
      "Claude Code updated successfully" +
      (S.versionState.currentVersion ? " to v" + S.versionState.currentVersion : "") + ".");

    if (wasRunning) {
      setTimeout(function() {
        try { R.Bridge.startBridge(); } catch (err) {
          console.error("Claude Code Bridge: post-update restart failed:", err.message);
          R.Util.showNotification("Restart Failed", "Update succeeded but bridge restart failed: " + err.message);
        }
      }, 300);
    }
  } else {
    // Don't auto-restart the bridge on failure — leave the user in a stable
    // state so they can diagnose. The previous claude is still installed.
    const stderr = (result.stderr || "").trim();
    const req = new NotificationRequest("claudecode-update-failed");
    req.title = "Claude Code Update Failed";
    req.body = stderr ? stderr.slice(0, 500) : "Update command returned a non-zero exit code.";
    req.actions = ["Copy Log", "OK"];
    nova.notifications.add(req).then(function(response) {
      if (response.actionIdx === 0) {
        const full = "stdout:\n" + (result.stdout || "") + "\n\nstderr:\n" + (result.stderr || "");
        nova.clipboard.writeText(full);
      }
    });
  }
}

async function runInstallFlow() {
  if (S.updateInProgress) {
    R.Util.showNotification("Install In Progress", "An install is already running.");
    return;
  }
  S.updateInProgress = true;
  R.Util.showNotification("Installing", "Installing @anthropic-ai/claude-code globally via npm…");

  let result;
  try {
    result = await UpdateCheck.installViaNpm();
  } catch (err) {
    result = { success: false, stderr: err.message };
  }
  S.updateInProgress = false;

  if (result.success) {
    R.Util.showNotification("Install Complete", "Claude Code installed. Run \"Check for Updates\" to refresh the sidebar.");
    // Trigger a re-check so the sidebar updates without user action.
    checkForUpdates(true).catch(function(_) {});
  } else {
    const req = new NotificationRequest("claudecode-install-failed");
    req.title = "Install Failed";
    req.body = (result.stderr || "npm install exited with a non-zero code.").slice(0, 500);
    req.actions = ["Copy Log", "OK"];
    nova.notifications.add(req).then(function(response) {
      if (response.actionIdx === 0) {
        nova.clipboard.writeText("stdout:\n" + (result.stdout || "") + "\n\nstderr:\n" + (result.stderr || ""));
      }
    });
  }
}

function persistLastChecked() {
  try {
    nova.config.set("claudecode.updateCheck.lastCheckedAt", Date.now());
    if (S.versionState.currentVersion) {
      nova.config.set("claudecode.updateCheck.lastSeenVersion", S.versionState.currentVersion);
    }
  } catch (err) {
    console.warn("Claude Code Bridge: could not persist lastCheckedAt:", err.message);
  }
  S.versionState.lastCheckedAt = Date.now();
}

R.Updates = Object.assign(R.Updates || {}, {
  maybeAutoCheckUpdates,
  checkForUpdates,
  presentUpdateAvailable,
  presentNotInstalled,
  runUpdateFlow,
  runInstallFlow,
  persistLastChecked,
});
module.exports = R.Updates;
