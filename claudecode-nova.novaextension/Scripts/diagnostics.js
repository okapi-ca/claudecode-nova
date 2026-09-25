// diagnostics.js — project-linter fallback behind the `getDiagnostics` MCP tool.
//
// Nova exposes no API for reading another extension's LSP diagnostics, so the
// editor-side answer is always empty. Claude Code calls getDiagnostics after
// nearly every edit (the VS Code / JetBrains plugins feed it TypeScript and
// ESLint errors), which means it never saw its own mistakes here. This module
// gives it real diagnostics by running the linters the project already has —
// TypeScript, ESLint, Ruff — and translating their output to the protocol
// shape:
//
//   [{ uri: "file:///abs/path", diagnostics: [{ message, severity, range,
//      source, code }] }]
//
// Runs inside ws-server.js (Node, CommonJS — node built-ins only). Detection is
// table-driven (see RUNNERS): a runner is used when its config marker exists in
// the workspace and its binary resolves (project node_modules/.bin, project
// venv, then PATH). Runners execute in parallel under one deadline; whatever
// has not finished by then is reported as `timeout`, never as "no errors".
// Concurrent calls share one in-flight run, and a finished run is served from
// cache for CACHE_MS so an agent loop that asks three times in a row pays once.

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { fileURLToPath, pathToFileURL } = require("url");

const CACHE_MS = 4000;
const OUTPUT_CAP = 4 * 1024 * 1024;   // bytes of linter stdout we keep

// ---------------------------------------------------------------------------
// Runner table
// ---------------------------------------------------------------------------
// Each runner: { name, source, markers, binary, args(target), parse(stdout,
// stderr, code, ctx) → [{file, line, character, endLine?, endCharacter?,
// severity, message, code}] } with 1-based lines/columns as the tools print
// them; toRange() converts to the protocol's 0-based positions.

const RUNNERS = [
  {
    name: "typescript",
    source: "typescript",
    markers: ["tsconfig.json"],
    binary: { local: ["node_modules/.bin/tsc"], global: ["tsc"] },
    // tsc has no single-file mode against a project; run the project and
    // filter afterwards (see filterToUri).
    args: () => ["--noEmit", "--pretty", "false", "-p", "tsconfig.json"],
    parse: (stdout) => {
      const out = [];
      // src/a.ts(12,5): error TS2322: Type 'x' is not assignable …
      const re = /^(.+?)\((\d+),(\d+)\): (error|warning) (TS\d+): (.*)$/;
      for (const raw of stdout.split("\n")) {
        const m = re.exec(raw.trim());
        if (!m) continue;
        out.push({
          file: m[1], line: +m[2], character: +m[3],
          severity: m[4] === "error" ? "Error" : "Warning",
          code: m[5], message: m[6],
        });
      }
      return out;
    },
  },
  {
    name: "eslint",
    source: "eslint",
    markers: [
      "eslint.config.js", "eslint.config.mjs", "eslint.config.cjs", "eslint.config.ts",
      ".eslintrc", ".eslintrc.js", ".eslintrc.cjs", ".eslintrc.json", ".eslintrc.yml", ".eslintrc.yaml",
    ],
    binary: { local: ["node_modules/.bin/eslint"], global: ["eslint"] },
    args: (target) => ["-f", "json", "--no-error-on-unmatched-pattern", target || "."],
    parse: (stdout) => {
      let files;
      try { files = JSON.parse(stdout); } catch (_) { return []; }
      if (!Array.isArray(files)) return [];
      const out = [];
      for (const f of files) {
        for (const m of f.messages || []) {
          out.push({
            file: f.filePath,
            line: m.line || 1, character: m.column || 1,
            endLine: m.endLine, endCharacter: m.endColumn,
            severity: m.fatal || m.severity === 2 ? "Error" : "Warning",
            code: m.ruleId || (m.fatal ? "parse" : null),
            message: m.message,
          });
        }
      }
      return out;
    },
  },
  {
    name: "ruff",
    source: "ruff",
    markers: ["ruff.toml", ".ruff.toml", "pyproject.toml"],
    binary: { local: [".venv/bin/ruff", "venv/bin/ruff"], global: ["ruff"] },
    args: (target) => ["check", "--output-format", "json", "--exit-zero", target || "."],
    parse: (stdout) => {
      let items;
      try { items = JSON.parse(stdout); } catch (_) { return []; }
      if (!Array.isArray(items)) return [];
      return items.map((d) => ({
        file: d.filename,
        line: d.location && d.location.row || 1,
        character: d.location && d.location.column || 1,
        endLine: d.end_location && d.end_location.row,
        endCharacter: d.end_location && d.end_location.column,
        // Ruff does not grade findings; syntax errors have no code.
        severity: d.code ? "Warning" : "Error",
        code: d.code || "syntax",
        message: d.message,
      }));
    },
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function exists(p) {
  try { fs.accessSync(p); return true; } catch (_) { return false; }
}

function isExecutable(p) {
  try { fs.accessSync(p, fs.constants.X_OK); return fs.statSync(p).isFile(); } catch (_) { return false; }
}

function whichOnPath(name, env) {
  const dirs = String((env && env.PATH) || "").split(path.delimiter).filter(Boolean);
  for (const d of dirs) {
    const cand = path.join(d, name);
    if (isExecutable(cand)) return cand;
  }
  return null;
}

function resolveBinary(runner, workspace, env) {
  for (const rel of runner.binary.local) {
    const abs = path.join(workspace, rel);
    if (isExecutable(abs)) return abs;
  }
  for (const name of runner.binary.global) {
    const found = whichOnPath(name, env);
    if (found) return found;
  }
  return null;
}

function hasMarker(runner, workspace) {
  return runner.markers.find((m) => exists(path.join(workspace, m))) || null;
}

// Linters print absolute paths as the OS resolves them (macOS: /private/var/…)
// while we may hold the symlinked spelling (/var/…). Compare and emit real
// paths so one file never shows up under two URIs.
function realpathSafe(p) {
  try { return fs.realpathSync.native(p); } catch (_) { return path.normalize(p); }
}

function absoluteIn(file, workspace) {
  return realpathSafe(path.isAbsolute(file) ? file : path.join(workspace, file));
}

function uriToPath(uri) {
  if (!uri) return null;
  if (uri.startsWith("file://")) {
    try { return fileURLToPath(uri); } catch (_) { return null; }
  }
  return uri;
}

function toUri(file, workspace) {
  return pathToFileURL(absoluteIn(file, workspace)).href;
}

function toRange(d) {
  const start = { line: Math.max(0, (d.line || 1) - 1), character: Math.max(0, (d.character || 1) - 1) };
  const end = {
    line: Math.max(0, (d.endLine || d.line || 1) - 1),
    character: Math.max(0, (d.endCharacter || d.character || 1) - 1),
  };
  return { start, end };
}

function runOne(runner, { workspace, target, env, deadlineMs }) {
  const startedAt = Date.now();
  const marker = hasMarker(runner, workspace);
  if (!marker) return Promise.resolve({ runner, status: "skipped", reason: "no config", ms: 0, items: [] });
  const bin = resolveBinary(runner, workspace, env);
  if (!bin) return Promise.resolve({ runner, status: "skipped", reason: `${marker} present but ${runner.binary.global[0]} not found`, ms: 0, items: [] });

  return new Promise((resolve) => {
    let stdout = "", stderr = "", done = false, timedOut = false;
    let child;
    try {
      // detached → own process group, so a timeout can kill the linter AND
      // anything it spawned (a wrapper script's node child, for instance).
      // Otherwise the orphan keeps our stdout pipe open and "close" never fires.
      child = spawn(bin, runner.args(target), { cwd: workspace, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    } catch (err) {
      return resolve({ runner, status: "error", reason: err.message, ms: 0, items: [] });
    }
    const killGroup = () => {
      try { process.kill(-child.pid, "SIGKILL"); } catch (_) { try { child.kill("SIGKILL"); } catch (_) {} }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
      finish(null, null);   // don't wait for the pipes to drain
    }, deadlineMs);
    child.stdout.on("data", (c) => { if (stdout.length < OUTPUT_CAP) stdout += c; });
    child.stderr.on("data", (c) => { if (stderr.length < OUTPUT_CAP) stderr += c; });
    function finish(code, err) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      const ms = Date.now() - startedAt;
      if (timedOut) return resolve({ runner, status: "timeout", reason: `exceeded ${deadlineMs} ms`, ms, items: [] });
      if (err) return resolve({ runner, status: "error", reason: err.message, ms, items: [] });
      let items = [];
      try { items = runner.parse(stdout, stderr, code) || []; }
      catch (e) { return resolve({ runner, status: "error", reason: `parse: ${e.message}`, ms, items: [] }); }
      // A non-zero exit with nothing parsed and something on stderr means
      // the tool itself failed (bad config, crash) — say so rather than
      // reporting a clean bill.
      if (code !== 0 && items.length === 0 && stderr.trim()) {
        return resolve({ runner, status: "error", reason: stderr.trim().split("\n")[0].slice(0, 200), ms, items: [] });
      }
      resolve({ runner, status: "ok", ms, items });
    }
    child.on("error", (err) => finish(null, err));
    child.on("close", (code) => finish(code, null));
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

let inflight = null;      // { key, promise }
let cache = null;         // { key, at, result }

/**
 * Run every applicable linter and return { files, sources, summary }.
 *   files   — protocol array: [{ uri, diagnostics: [...] }]
 *   sources — [{ name, status, count, ms, reason? }] one per runner
 *   summary — one human line, e.g. "typescript: 3 issues (4.9 s) · eslint: 0 · ruff: skipped (no config)"
 *
 * @param {object} opts
 * @param {string} opts.workspace   absolute workspace root
 * @param {string} [opts.uri]       file:// URI or path to scope the result to one file
 * @param {number} [opts.timeoutMs] deadline for the slowest runner (default 20 000)
 * @param {object} [opts.env]       environment for the linters (default process.env)
 * @param {function} [opts.log]
 */
async function runDiagnostics(opts) {
  const workspace = opts.workspace;
  const timeoutMs = opts.timeoutMs || 20000;
  const env = opts.env || process.env;
  const targetPath = uriToPath(opts.uri);
  const key = `${workspace}|${targetPath || "*"}`;

  if (cache && cache.key === key && Date.now() - cache.at < CACHE_MS) return cache.result;
  if (inflight && inflight.key === key) return inflight.promise;

  const promise = (async () => {
    const results = await Promise.all(RUNNERS.map((r) => runOne(r, {
      workspace,
      // tsc ignores the target (project-wide, filtered below); others lint just the file.
      target: r.name === "typescript" ? null : targetPath,
      env,
      deadlineMs: timeoutMs,
    })));

    const byUri = new Map();
    const sources = [];
    for (const r of results) {
      let items = r.items;
      if (targetPath) {
        const want = absoluteIn(targetPath, workspace);
        items = items.filter((d) => absoluteIn(d.file, workspace) === want);
      }
      for (const d of items) {
        const uri = toUri(d.file, workspace);
        if (!byUri.has(uri)) byUri.set(uri, []);
        byUri.get(uri).push({
          message: d.message,
          severity: d.severity,
          range: toRange(d),
          source: r.runner.source,
          code: d.code || undefined,
        });
      }
      sources.push({ name: r.runner.name, status: r.status, count: items.length, ms: r.ms, reason: r.reason });
      if (opts.log && r.status !== "ok" && r.status !== "skipped") opts.log("warn", `diagnostics: ${r.runner.name} ${r.status} — ${r.reason}`);
    }

    const files = [...byUri.entries()].map(([uri, diagnostics]) => ({ uri, diagnostics }));
    if (targetPath && files.length === 0) files.push({ uri: toUri(targetPath, workspace), diagnostics: [] });

    const summary = sources.map((s) => {
      if (s.status === "ok") return `${s.name}: ${s.count} issue${s.count === 1 ? "" : "s"} (${(s.ms / 1000).toFixed(1)} s)`;
      return `${s.name}: ${s.status}${s.reason ? ` (${s.reason})` : ""}`;
    }).join(" · ");

    const result = { files, sources, summary };
    cache = { key, at: Date.now(), result };
    return result;
  })();

  inflight = { key, promise };
  try { return await promise; }
  finally { if (inflight && inflight.promise === promise) inflight = null; }
}

function clearCache() { cache = null; }

module.exports = { runDiagnostics, clearCache, RUNNERS, CACHE_MS };
