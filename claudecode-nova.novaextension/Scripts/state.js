// state.js — Shared mutable state — one object, required by every module as `S`.
//
// Mutable extension state lives here (not in the modules that use it) so
// that reassignments like `S.isConnected = true` are visible everywhere —
// CommonJS `require` copies bindings, it does not share them.

const S = {};

S.UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24h auto-check throttle

S.serverProcess = null;

S.serverPort = null;

S.isConnected = false;

S.clientCount = 0;

S.disposables = [];

S.lastSelection = null;

S.stdoutBuffer = "";

// Activity tracking — feeds the Activity and Pending Diffs sidebar sections.
// activityLog: visible-effect events (file_opened, diff_accepted, …).
// toolCallLog: every raw tool call, surfaced under a collapsible group.
// pendingDiffs: diffs awaiting Accept/Reject (notification + sidebar both
//   resolve through resolveDiff()).
S.activityLog = [];

S.toolCallLog = [];

S.pendingDiffs = [];

S.ACTIVITY_MAX = 50;

S.TOOLCALLS_MAX = 100;

S.activityRefreshTimer = null;

S.activityPersistTimer = null;

S.ACTIVITY_PERSIST_DEBOUNCE_MS = 1000;

// Git branch cache. Refreshed on bridge start, after notable events, and on
// a 5-minute interval. Sent in selection_update payloads and surfaced in
// getWorkspaceFolders so Claude can mention "you're on feature/foo" without
// having to call out to git itself.
S.gitBranch = null;

S.gitBranchTimer = null;

S.GIT_BRANCH_REFRESH_MS = 5 * 60 * 1000;

// Claude Code CLI version state. Mutated by checkForUpdates() and read by
// the sidebar provider — same object reference passed both ways so the
// provider always reflects the latest snapshot after a reload().
S.versionState = {
  state: "unknown",
  currentVersion: null,
  latestVersion: null,
  channel: "stable",
  lastCheckedAt: null,
  message: null,
};

S.versionProvider = null;

S.versionTree = null;

S.updateInProgress = false;

// Chat UI (Mode B) lifecycle state. Mutated by startBridge() and the
// chat_started / chat_failed messages from ws-server.js. The same object
// is shared with ChatStatusTreeProvider.
S.chatState = {
  state: "disabled",         // disabled | no_key | starting | running | failed | stopped
  port: null,
  model: null,
  apiKeySource: null,        // "keychain" | "1password" | "config"
  lastError: null,
  url: null,               // full URL incl. ?token=… — what "Open"/"Copy URL" hand out
  token: null,             // shared secret for /ws and /cli (see Scripts/ws-auth.mjs)
  lastUpdatedAt: null,
};

S.chatStatusProvider = null;

S.chatStatusTree = null;

S.sidebarProvider = null;

S.sidebarTree = null;

S.diffsProvider = null;

S.diffsTree = null;

S.activityProvider = null;

S.activityTree = null;

S.sessionsProvider = null;

S.sessionsTree = null;

S.sessionsWatcher = null;

// Watch the per-workspace session directory so the sidebar updates when
// Claude Code creates a new session or appends to an existing one. fs.watch
// is debounced via a short timer because a single Claude turn appends many
// JSONL events in quick succession.
S.sessionsRefreshTimer = null;

// Crash recovery for the ws-server subprocess (bridge.js). stopRequested
// distinguishes an exit we asked for (Stop / Restart / deactivate — Nova
// reloads the extension on every file change) from a crash. Only crashes
// are retried, with backoff and a cap; lastStderr keeps the tail of the
// helper's stderr so the give-up notification can say why.
S.stopRequested = false;

S.serverStartedAt = 0;

S.crashRestart = { attempts: 0, timer: null, lastStderr: [] };

S.CRASH_RESTART_MAX = 3;            // attempts before giving up…

S.CRASH_RESTART_WINDOW_MS = 60000;  // …unless the server lived this long

S.CRASH_RESTART_BASE_DELAY_MS = 1000;   // 1 s, 2 s, 4 s

// Live Claude Code sessions reported through the hook relay (hooks.js).
// Keyed by session_id → { sessionId, cwd, state, tool, lastMessage,
// lastError, model, permissionMode, startedAt, updatedAt, fromChat }.
// state ∈ working | waiting | idle | error. Sessions disappear on SessionEnd.
S.claudeSessions = {};

S.claudeSessionsRefreshTimer = null;

// Cached answer to "are our hooks installed in ~/.claude/settings.json?"
// — null until hooks.js has looked. Drives the one-time install offer.
S.hooksInstalled = null;

module.exports = S;