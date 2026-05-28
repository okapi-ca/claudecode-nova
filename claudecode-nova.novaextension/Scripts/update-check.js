/**
 * update-check.js — version detection, comparison, and update execution for
 * the Claude Code CLI. Runs in Nova's JavaScriptCore runtime (not Node), so
 * everything uses Nova's Process / fetch / nova.fs APIs.
 *
 * Exports:
 *   getCurrentVersion(claudeCommand) → Promise<CurrentVersionResult>
 *   getLatestVersion(channel)        → Promise<LatestVersionResult>
 *   detectInstallMethod(claudePath)  → "npm" | "homebrew" | "standalone" | "unknown"
 *   resolveClaudePath(claudeCommand) → Promise<string | null>
 *   isNpmAvailable()                 → Promise<boolean>
 *   runUpdate(method, claudeCommand) → Promise<UpdateResult>
 *   semverCompare(a, b)              → number | null
 *
 * State values for getCurrentVersion:
 *   "installed"     — binary present, version parsed
 *   "not_installed" — ENOENT / command not found
 *   "unknown"       — present but version output not parsable
 */

const NPM_REGISTRY_URL = "https://registry.npmjs.org/@anthropic-ai/claude-code";
const FETCH_TIMEOUT_MS = 5000;

// ---------------------------------------------------------------------------
// Semver
// ---------------------------------------------------------------------------

function parseSemver(v) {
  if (!v || typeof v !== "string") return null;
  const m = v.match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([\w.]+))?$/);
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] || null };
}

// Returns negative if a<b, 0 if equal, positive if a>b, null if unparsable.
// Per semver: X.Y.Z > X.Y.Z-anything (releases sort higher than pre-releases).
function semverCompare(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return null;
  const core = (pa.major - pb.major) || (pa.minor - pb.minor) || (pa.patch - pb.patch);
  if (core !== 0) return core;
  if (pa.pre === pb.pre) return 0;
  if (pa.pre === null) return 1;
  if (pb.pre === null) return -1;
  return pa.pre < pb.pre ? -1 : 1;
}

// ---------------------------------------------------------------------------
// Process helper — captures stdout, stderr, exit code without throwing.
// Returns { code, stdout, stderr, spawnError? }.
// ---------------------------------------------------------------------------

function runProcess(command, args, options) {
  return new Promise(function(resolve) {
    let proc;
    try {
      proc = new Process(command, Object.assign({
        args: args || [],
        shell: false,
        stdio: "pipe",
      }, options || {}));
    } catch (err) {
      resolve({ code: -1, stdout: "", stderr: "", spawnError: err.message });
      return;
    }

    let stdout = "";
    let stderr = "";
    proc.onStdout(function(chunk) { stdout += chunk; });
    proc.onStderr(function(chunk) { stderr += chunk; });
    proc.onDidExit(function(code) {
      resolve({ code: code, stdout: stdout, stderr: stderr });
    });

    try {
      proc.start();
    } catch (err) {
      resolve({ code: -1, stdout: "", stderr: "", spawnError: err.message });
    }
  });
}

// ---------------------------------------------------------------------------
// Resolve claude binary path via `which`
// ---------------------------------------------------------------------------

async function resolveClaudePath(claudeCommand) {
  const cmd = claudeCommand || "claude";

  // If the user configured an absolute path, take it at face value if it
  // exists on disk. Avoids a spurious `which` call.
  if (cmd.startsWith("/")) {
    try {
      if (nova.fs.stat(cmd)) return cmd;
    } catch (_) {}
    return null;
  }

  const result = await runProcess("/usr/bin/which", [cmd]);
  if (result.code === 0) {
    const path = result.stdout.trim().split("\n")[0];
    return path || null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Current installed version
// ---------------------------------------------------------------------------

async function getCurrentVersion(claudeCommand) {
  const cmd = claudeCommand || "claude";
  const path = await resolveClaudePath(cmd);

  if (!path) {
    return { state: "not_installed", path: null };
  }

  const result = await runProcess(path, ["--version"]);

  if (result.spawnError) {
    // ENOENT case — binary moved between which() and exec()
    return { state: "not_installed", path: path, error: result.spawnError };
  }

  if (result.code !== 0) {
    // claude --version should not fail; treat as unknown so the UI surfaces it.
    return {
      state: "unknown",
      path: path,
      error: (result.stderr || result.stdout || "exit code " + result.code).trim(),
    };
  }

  // Claude Code CLI version output formats observed:
  //   "1.2.3 (Claude Code)"
  //   "claude-code/1.2.3 (node)"
  //   "1.2.3"
  // Pattern: capture first X.Y.Z[-pre] anywhere on the first line.
  const firstLine = (result.stdout || "").trim().split("\n")[0];
  const match = firstLine.match(/(\d+\.\d+\.\d+(?:-[\w.]+)?)/);

  if (!match) {
    return { state: "unknown", path: path, raw: firstLine };
  }

  return { state: "installed", path: path, version: match[1], raw: firstLine };
}

// ---------------------------------------------------------------------------
// Latest published version (npm registry)
// ---------------------------------------------------------------------------

function fetchWithTimeout(url, ms) {
  return new Promise(function(resolve, reject) {
    let settled = false;
    const timer = setTimeout(function() {
      if (!settled) {
        settled = true;
        reject(new Error("Request timed out after " + ms + "ms"));
      }
    }, ms);

    fetch(url, {
      headers: {
        "Accept": "application/json",
        "User-Agent": "claudecode-nova/" + (nova.extension.version || "0.0.0"),
      },
    }).then(function(response) {
      if (settled) return;
      clearTimeout(timer);
      settled = true;
      resolve(response);
    }).catch(function(err) {
      if (settled) return;
      clearTimeout(timer);
      settled = true;
      reject(err);
    });
  });
}

async function getLatestVersion(channel) {
  const ch = channel === "next" ? "next" : "stable";

  let response;
  try {
    response = await fetchWithTimeout(NPM_REGISTRY_URL, FETCH_TIMEOUT_MS);
  } catch (err) {
    throw new Error("Could not reach npm registry: " + err.message);
  }

  if (!response.ok) {
    throw new Error("npm registry returned HTTP " + response.status);
  }

  const data = await response.json();
  const distTags = data["dist-tags"] || {};
  const tag = ch === "next" ? "next" : "latest";
  const version = distTags[tag];

  if (!version) {
    // Fallback to stable if next isn't published yet.
    if (ch === "next" && distTags.latest) {
      return { version: distTags.latest, channel: "stable", fellBack: true };
    }
    throw new Error("npm registry did not return a version for tag '" + tag + "'");
  }

  return { version: version, channel: ch, fellBack: false };
}

// ---------------------------------------------------------------------------
// Install method detection
// ---------------------------------------------------------------------------

function detectInstallMethod(claudePath) {
  if (!claudePath) return "unknown";
  const p = claudePath;

  if (p.indexOf("/.nvm/") !== -1) return "npm";
  if (p.indexOf("/node_modules/") !== -1) return "npm";
  if (p.indexOf("/lib/node_modules/") !== -1) return "npm";
  if (p.indexOf("/Cellar/") !== -1) return "homebrew";
  if (p.indexOf("/opt/homebrew/") !== -1) return "homebrew";
  if (p.indexOf("/.local/") !== -1) return "standalone";
  if (p.indexOf("/.claude/") !== -1) return "standalone";

  return "unknown";
}

async function isNpmAvailable() {
  const result = await runProcess("/usr/bin/which", ["npm"]);
  return result.code === 0 && result.stdout.trim().length > 0;
}

// ---------------------------------------------------------------------------
// Update execution
// ---------------------------------------------------------------------------

const UPDATE_COMMANDS = {
  // `claude update` is the modern updater — prefer it everywhere it works.
  "self":      { cmd: "claude",  args: ["update"] },
  "npm":       { cmd: "npm",     args: ["update", "-g", "@anthropic-ai/claude-code"] },
  "homebrew":  { cmd: "brew",    args: ["upgrade", "claude-code"] },
  "standalone":{ cmd: "claude",  args: ["update"] },
  "install-npm": { cmd: "npm",   args: ["install", "-g", "@anthropic-ai/claude-code"] },
};

// Try `claude update` first (works for the modern CLI regardless of install
// method). On failure, fall back to the method-specific command.
async function runUpdate(method, claudeCommand) {
  const cmd = claudeCommand || "claude";
  const claudePath = await resolveClaudePath(cmd);

  // Attempt the integrated updater first when a claude binary is on the PATH.
  if (claudePath) {
    const selfRes = await runProcess(claudePath, ["update"]);
    if (selfRes.code === 0) {
      return {
        success: true,
        method: "self",
        stdout: selfRes.stdout,
        stderr: selfRes.stderr,
      };
    }
    // Self-update can refuse with a non-zero code if the install method
    // doesn't support it — fall through to package-manager-specific commands.
  }

  const fallback = UPDATE_COMMANDS[method];
  if (!fallback || method === "unknown" || method === "self") {
    return {
      success: false,
      method: method,
      stdout: "",
      stderr: claudePath
        ? "`claude update` failed and no package-manager fallback is known for this install."
        : "Claude Code CLI is not installed.",
    };
  }

  const result = await runProcess("/usr/bin/env", [fallback.cmd].concat(fallback.args));
  return {
    success: result.code === 0,
    method: method,
    stdout: result.stdout,
    stderr: result.stderr,
    code: result.code,
  };
}

// Install Claude Code via npm. Separate entry point because UX-wise this is
// distinct from "update an existing install" — the caller surfaces a
// dedicated button only when isNpmAvailable() is true.
async function installViaNpm() {
  const spec = UPDATE_COMMANDS["install-npm"];
  const result = await runProcess("/usr/bin/env", [spec.cmd].concat(spec.args));
  return {
    success: result.code === 0,
    method: "install-npm",
    stdout: result.stdout,
    stderr: result.stderr,
    code: result.code,
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  parseSemver: parseSemver,
  semverCompare: semverCompare,
  getCurrentVersion: getCurrentVersion,
  getLatestVersion: getLatestVersion,
  resolveClaudePath: resolveClaudePath,
  detectInstallMethod: detectInstallMethod,
  isNpmAvailable: isNpmAvailable,
  runUpdate: runUpdate,
  installViaNpm: installViaNpm,
};
