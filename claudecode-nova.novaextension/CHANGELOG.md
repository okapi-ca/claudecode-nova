# Changelog

## 0.13.0 — 2026-05-29

### Added
- **Embedded CLI terminal in the chat window.** node-pty +
  xterm.js power a real PTY inside the same page that hosts the
  chat. ws-server exposes a sibling `/cli` WebSocket alongside the
  existing `/ws` and pipes input/output/resize/exit messages
  between the browser terminal and a `claude` subprocess.
- **Three-way layout toggle** in the topbar: **Chat** / **CLI** /
  **Both**. In Both mode, the terminal sits on top of the chat
  (CSS `order` swap) with a draggable horizontal splitter that
  re-fits xterm and pings the PTY with the new dims as the user
  drags.
- **Persistent bottom statusbar** with two live readouts:
  - **Bridge:** `port N · K clients` (green dot when the MCP
    server is listening, count updates as Claude CLI instances
    connect/disconnect on the bridge port).
  - **Chat:** `MODE · model · port` (reflects the model picker and
    the SDK/CLI mode in real time).
- **`claudecode.chat.theme`** setting (`auto` / `dark` / `light`).
  Nova doesn't expose its active theme to extensions, so users
  whose Nova is locked to one theme while macOS uses the other
  can force-match. All previous `@media
  (prefers-color-scheme: light)` blocks were rewritten as
  `:root[data-theme="light"]` scoped selectors so the JS override
  works on every rule, not just the OS-driven branch. The xterm.js
  terminal also follows via `syncTerminalTheme()`.

### Changed
- **Chrome restructure.** Topbar, panels frame, and composer share
  a darker tone (`#15151a` dark / `#ececef` light) so the inner
  chat and terminal panels read as elevated cards. The composer
  is now nested inside a `.chat-panel` wrapper, so its input
  stays glued to the chat history when the layout splits.
- **`session_started`** event now carries a `mode` field so the UI
  can label CLI vs SDK from the very first turn (previously had
  to wait for the next config push).

### Fixed
- **`posix_spawnp failed` when spawning the embedded terminal's
  `claude`** — node-pty's prebuilt `spawn-helper` ships without
  the execute bit. The `postinstall` script now runs
  `chmod +x node_modules/node-pty/prebuilds/*/spawn-helper` so
  the silent failure stops happening after every install.
- **PATH inheritance for the embedded PTY.** Nova's subprocess
  PATH is trimmed and typically excludes `~/.local/bin` (where
  Claude Code installs `claude`). `cli-session.mjs` now extends
  PATH with `~/.local/bin`, `/usr/local/bin`, and
  `/opt/homebrew/bin` before spawning so a plain `"claude"` binary
  reference resolves.
- **Sibling `/cli` WebSocket was returning HTTP 400.** When two
  `WebSocketServer({ server, path })` instances share the same
  HTTP server, the first one's upgrade listener takes every
  upgrade and rejects anything that doesn't match its path. Both
  WSSes now use `noServer: true` with a manual `httpServer.on
  ("upgrade", …)` router that dispatches by URL path.

### Packaging
- `node-pty@^1.1.0` added to `Scripts/package.json` dependencies.
  Prebuilds for darwin-arm64 and darwin-x64 bring ~62 MB of native
  binaries — acceptable because the extension is macOS-only via
  Nova.

## 0.12.1 — 2026-05-28

### Added
- **Chat UI follows the system / Nova theme.** The chat panel was
  hardcoded dark and clashed when Nova / macOS were set to light
  mode. A `@media (prefers-color-scheme: light)` block in `chat.css`
  overrides every CSS variable plus the ~25 colors that were
  hardcoded outside `:root` (slash menu, model picker, scrollbars,
  CLI/SDK badge, thinking block, pending placeholder). The Nova
  Preview tab is WebKit-backed and honours the macOS appearance, so
  the whole panel flips automatically when the user toggles Light /
  Dark — no setting, no reload.
- `<meta name="color-scheme" content="light dark">` so native form
  controls (`<select>`, `<input type="checkbox">`) follow the theme
  too.
- Highlight.js code blocks swap `atom-one-dark` ↔ `atom-one-light`
  via media-scoped `<link>` tags so syntax-highlighted code stays
  readable in either mode.
- The `chat-frame.html` wrapper used by "Open in Nova Preview" got
  a `color-scheme: light dark` declaration and a light-mode
  background override so the iframe doesn't flash a dark background
  on light systems while it loads.

## 0.12.0 — 2026-05-28

### Added
- **Model picker + mode badge now reflect the configured default
  immediately on chat load.** A new `{type: "config", defaultModel,
  mode}` WS event is pushed the moment a client connects, before
  any `session_started`. The picker syncs to whatever you set in
  `claudecode.chat.model` (e.g. Opus 4.8) and the CLI / SDK badge
  is rendered right away — no more "Sonnet 4.6 then jump to Opus"
  flicker after the first message.

### Changed
- Refactored the badge-rendering inline block out of the
  `session_started` handler into a reusable `applyModeBadge(mode)`
  helper. Both the new `config` event and existing `session_started`
  event share the same code path.

## 0.11.1 — 2026-05-28

### Fixed
- **`nova extension validate` was failing** with
  `"The package does not have a valid extension.json file."` even
  though the manifest was syntactically correct. Root cause:
  `Scripts/node_modules/.bin/` contained two symlinks
  (`node-which`, `anthropic-ai-sdk`) and Nova's validator does not
  follow symlinks inside the bundle, which blocked
  `nova extension publish` entirely. The `.bin/` directory only
  holds CLI wrappers used by npm scripts at dev time — nothing
  referenced at runtime by `ws-server.js` or `chat-session.mjs` —
  so it can be removed unconditionally. Added a `postinstall`
  script to `Scripts/package.json` that runs
  `rm -rf node_modules/.bin` after every install, so future
  `npm install` runs don't reintroduce the validation failure.

### Documentation
- **README "Roadmap" section was frozen at v0.2.0 / v0.3.0** and
  hadn't been updated as the extension grew. Replaced with a
  chronological "Recent Releases" rundown covering v0.6.x through
  v0.11.0 (Chat UI, slash commands, CLI fallback, Nova Preview
  docking, model picker / thinking stream) plus a "Future ideas"
  section.

## 0.11.0 — 2026-05-28

### Added
- **Live model picker in the chat composer.** A `<select>` in the
  meta bar lets you switch between Sonnet 4.6, Haiku 4.5, Opus 4.7
  and the new Opus 4.8 (1M context) at any point — no bridge
  restart. The picker auto-syncs on `session_started` to whatever
  the backend actually launched with, then a new WS message
  `set_model` flips the shared `model` variable for the next
  prompt. Sessions that mix models continue working because the
  CLI's `--resume <session_id>` and the SDK's `resume` option both
  accept a model change mid-conversation.
- **CLI / SDK mode badge** in the meta bar — a small green "CLI"
  or blue "SDK" pill with a tooltip explaining the billing source
  (Enterprise/Pro/Max subscription vs Anthropic API key). Makes the
  cost line below it unambiguous: in CLI mode the figure is
  informative-only (would-be API equivalent), in SDK mode it's the
  actual billed amount.
- **Live thinking stream.** When the CLI emits `thinking_delta`
  events (or the SDK emits `thinking` content blocks with extended
  thinking enabled), the chat shows a collapsible "💭 Reasoning…"
  block with a spinner that fills in real time as Claude reasons.
  Auto-collapses when the actual answer starts; click to re-open.
  Gives a clear "Claude is working in the background" signal that
  was previously invisible in CLI mode.
- **Pending placeholder** — three pulsing dots and "Claude is
  thinking…" appear immediately after Send, until the first delta
  arrives (typically 1-3s on cold context). Prevents the
  "is-it-frozen?" feeling on the latency-prone first chunk.
- **`Opus 4.8 (1M context)`** added to the model enum in
  `extension.json`. Available immediately on Claude Code CLI
  subscriptions; for SDK mode, depends on API key access.

### Changed
- The CLI subprocess parser now handles three more event categories
  in addition to `text_delta` and `result`: `thinking_delta`,
  top-level `assistant` events containing `tool_use` blocks, and
  top-level `user` events containing `tool_result` blocks. As a
  result, Bash/Read/Edit and other tool invocations that the
  `claude` CLI performs internally are now surfaced as tool cards
  in the chat UI with the same "running" spinner that SDK mode has.
- Status bar text transitions reflect the active stage:
  `Sending…` → `Thinking aloud…` (during reasoning) → `Using
  <tool>…` → `Processing result…` → `Writing response…` → `Ready`.
- The `session_started` server event now includes a `mode` field
  (`"cli"` or `"sdk"`) so the frontend can render the badge.

## 0.10.0 — 2026-05-28

### Added
- **"Open in Nova Preview" — chat now docks inside Nova.** The
  "Open Claude Chat in Browser" command's action panel gained a new
  first button that writes an iframe wrapper (`chat-frame.html`) into
  the extension's global storage and opens it as an editor tab. From
  there, `Cmd+Shift+H` shows the chat in Nova's WebKit Preview tab —
  drag the Preview tab to the right edge to dock it as a side panel,
  similar to VSCode's beside-panel webview. The other panel buttons
  (Open in Browser / Copy URL / Close) are preserved.
- The wrapper file is **idempotently regenerated**: only rewritten
  when missing, unreadable, or pointing at a stale URL (port change).
  User customizations (background, title, extra styles) survive
  across re-opens.

### Notes
- Nova does not expose a programmatic split-right + preview API
  (verified: AppleScript dictionary is minimal, `nova://` URL scheme
  is OAuth-only, UI scripting via System Events would require
  Accessibility permission). The wrapper-file + `Cmd+Shift+H`
  keypress is the closest approximation available today.

## 0.9.0 — 2026-05-28

### Added
- **CLI subprocess fallback for chat — works without an Anthropic API
  key.** When no key is resolved (Keychain / 1Password / direct config
  all empty), chat now spawns the `claude` CLI as a subprocess and
  parses its `--output-format stream-json` stream. The user's existing
  Claude Code OAuth session (Pro/Max) authenticates the calls, so chat
  usage is covered by the subscription instead of being billed against
  an API key. Detection is automatic — no new setting to configure.
  Multi-turn continuity is preserved via `--resume <session_id>`.
- **Chat UI Status sidebar surfaces the active mode.** The descriptive
  text now reads `SDK · <model>` or `CLI · <model>` so the user can
  see at a glance which path is active. Tooltip distinguishes
  "Anthropic SDK — key from <source>" vs "Claude Code CLI session
  (OAuth Pro/Max — no API key)".

### Changed
- `startBridge()` no longer disables chat when the API key is missing.
  It now always passes the chat env vars (`CC_CHAT_ENABLED`,
  `CC_CHAT_PORT`, `CC_CHAT_MODEL`) plus the new `CC_CLAUDE_PATH` to
  the ws-server, and only sets `ANTHROPIC_API_KEY` when a key was
  actually resolved.
- `ws-server.js` forwards a nullable `apiKey` and the new `claudePath`
  to `chat-session.init()` — the "key required" guard moved into
  chat-session itself, which picks the mode based on what it
  receives.

### Internal
- `runClaudeCLI()` in `chat-session.mjs` extends `process.env.PATH`
  with `~/.local/bin`, `/usr/local/bin`, `/opt/homebrew/bin` when the
  `claude` binary is referenced by name (Nova's subprocess PATH is
  trimmed; the CLI is typically installed under one of these dirs).
- Slash commands and workspace context auto-injection added in 0.8.0
  apply equally to CLI mode — both call into the same `buildPrompt()`
  helper before either driver consumes it.

### Limitations
- In CLI mode the in-process SDK tool wrappers (`chat-tool-wrappers.mjs`)
  are not exposed to Claude. The `claude` subprocess uses its own MCP
  bridge if one is reachable in the current Nova session, which is
  usually the case but is not enforced.

## 0.8.0 — 2026-05-28

### Added
- **Slash commands in the chat UI.** Typing `/` in the composer
  opens a filterable menu of templated prompts — `/explain`,
  `/refactor`, `/test`, `/doc`, `/fix`. Navigate with `↑`/`↓`,
  pick with `Enter`/`Tab`, cancel with `Esc`. The selected
  command is rendered as a prefix in the transcript so past
  turns stay readable. Each command maps to a server-side
  template (see `SLASH_TEMPLATES` in `chat-session.mjs`) that
  expands into a structured prompt.
- **Workspace context auto-injection.** A new "Auto-inject
  context" toggle (on by default) appears in the chat meta bar.
  When active, every prompt automatically prepends the user's
  current Nova selection plus file path, formatted as a markdown
  block — Claude no longer has to ask "what are you looking at?".
  Backend calls `getCurrentSelection` via the existing Nova tool
  plumbing, falls back gracefully on empty selection or lookup
  failure. The toggle is per-session; turn it off for general
  questions unrelated to your current code.
- **Composition: slash commands run on the current selection
  with zero typing.** Pick `/explain`, hit Enter twice → Claude
  explains the highlighted code in detail.

### Changed
- Chat composer textarea is now wrapped in a positioning
  container so the slash menu can float above it. The wrap
  preserves full-width layout via `display: flex` +
  `min-width: 0` + `box-sizing: border-box` on the inner
  textarea.

## 0.7.0 — 2026-05-28

### Added
- **Recent Sessions sidebar.** New section under the Claude Code
  sidebar that lists per-workspace Claude Code sessions read from
  `~/.claude/projects/<encoded-cwd>/*.jsonl`, sorted by recency, with
  the first real user-message excerpt as preview and a relative
  timestamp ("just now", "12m ago", "3d ago"). Clicking a row copies
  `claude --resume <id>` to the clipboard so you can paste it into
  any terminal. A header Refresh button rescans the directory; an
  `nova.fs.watch` keeps the list reactive while you work.
- **Chat UI Status sidebar.** Replaces the previous "Chat UI"
  placeholder section. Single-row tree view showing the chat server
  lifecycle (`disabled`, `missing API key`, `starting…`, `running on
  port N`, `failed to start`, or `stopped`), with the active model
  and API-key source (Keychain / 1Password / config) surfaced in the
  tooltip. Wired into `chat_started` / `chat_failed` events from
  `ws-server.js` plus the subprocess exit hook.

### Fixed
- **Version sidebar stuck on "unknown" at startup.** When the 24h
  auto-check throttle blocked the npm round-trip, `versionState`
  stayed at `"unknown"` and the row never populated until the user
  manually triggered a check. Now hydrates `currentVersion` from the
  cached `claudecode.updateCheck.lastSeenVersion` config before the
  throttle decision so the version appears immediately.

### Changed
- "Chat UI" sidebar section renamed to "Chat UI Status" to reflect
  its new content. The header "Open" button is unchanged.

### Internal
- `Scripts/main.js` is now the real entry point (the file Nova
  actually loads, despite `extension.json:main` pointing at the root
  `main.js`). Root `main.js` is kept as a synchronised copy because
  Nova refuses to load the extension if the manifest's main file is
  missing — confirmed empirically and re-documented in the v0.4.x
  CHANGELOG note. Edit `Scripts/main.js`, then mirror to root with
  `sed 's|require("\./|require("./Scripts/|g'`.

## 0.6.2 — 2026-05-28

### Added
- **Configurable Keychain service / account.** Two new settings
  (`claudecode.chat.keychainService`, `claudecode.chat.keychainAccount`)
  let users point the chat-key reader at an existing Keychain entry from
  another app (Claude Desktop, Cline, custom scripts, etc.) instead of
  duplicating the secret in this extension's namespace. Defaults stay at
  `ca.okapi.claudecode-nova` / `anthropic-api-key`, matching 0.6.1.

### Changed
- `Set` and `Clear` Keychain commands now read these config values so
  they operate on whichever entry is currently selected — and the
  notification bodies (input prompt, save confirmation, clear
  confirmation) display the resolved `service` / `account` so the user
  always sees exactly which entry is being touched. Useful safeguard
  when pointing at an external app's entry to avoid accidental
  overwrites or deletions.

## 0.6.1 — 2026-05-28

### Added
- **macOS Keychain as the preferred Anthropic API key source for chat (Mode B).**
  Two new commands : `Claude Code Bridge: Set Claude Chat API Key (Keychain)`
  prompts for the key via a secure-input notification and stores it via
  `nova.credentials.setPassword("ca.okapi.claudecode-nova", "anthropic-api-key", …)` ;
  `Claude Code Bridge: Clear Claude Chat API Key (Keychain)` removes it.
- **`resolveChatApiKey()` priority order revisited** : Keychain first
  (persistent, no session expiry), then 1Password CLI (only if a reference
  is configured), then the plain-text `claudecode.chat.apiKey` config as
  last resort. Eliminates the silent-failure case where `op read` fails
  because the 1Password CLI session expired (~30 min) and the bridge
  silently spawned without `CC_CHAT_ENABLED`.

### Changed
- Settings descriptions clarified : 1Password ref now warns about session
  expiry and points to the Keychain command as the recommended source.

## 0.6.0 — 2026-05-28

### Added
- **Chat UI (Mode B — opt-in, experimental).** In-browser chat powered
  by the Claude Agent SDK (`@anthropic-ai/claude-agent-sdk` v0.3.x),
  served on a fixed port (default 5180) by an HTTP+WS server embedded
  in `ws-server.js`. Coexists with the existing CLI bridge (Mode A) —
  both can run side-by-side. Open in Safari/Firefox or configure
  Nova's Preview tab to use it inline. New command
  `Claude Code: Open Claude Chat in Browser` shows an action panel
  with Copy URL / Open in Browser actions.
- **Twelve Nova editor tools exposed in-process to the SDK** via
  `createSdkMcpServer({ tools: [...] })` — `nova_openFile`,
  `nova_openDiff`, `nova_getCurrentSelection`, `nova_getLatestSelection`,
  `nova_getOpenEditors`, `nova_getWorkspaceFolders`,
  `nova_checkDocumentDirty`, `nova_saveDocument`, `nova_getDiagnostics`,
  `nova_close_tab`, `nova_closeAllDiffTabs`, `nova_executeCode`. Each
  wrapper round-trips through the existing `ws-server.js` ↔ `main.js`
  JSON-line protocol via a shared `pendingRequests` map dispatched by
  `kind: "mcp" | "chat"` — zero duplication of the editor-side
  plumbing.
- **1Password CLI key resolution** at extension activation.
  `claudecode.chat.apiKey1PassRef` (e.g.
  `op://Private/Anthropic API Key/credential`) runs `op read` to
  fetch the Anthropic key without storing it in extension config or
  Nova settings. Falls back to `claudecode.chat.apiKey` for users
  without 1Password CLI.
- **Cost-tuned defaults.** Sonnet 4.6 (default), `tools: []` (disables
  the 115 built-in Claude Code tools), `settingSources: []` (SDK
  isolation — no CLAUDE.md / skills / rules auto-load), wildcard
  `allowedTools: ["mcp__nova__*"]` for trusted Nova tools. Typical
  cost: ~$0.01–0.02 per multi-step interaction (vs ~$0.67 with
  defaults).
- **New config keys** : `claudecode.chat.enabled`,
  `claudecode.chat.apiKey1PassRef`, `claudecode.chat.apiKey`,
  `claudecode.chat.model` (Sonnet/Haiku/Opus), `claudecode.chat.port`.
- **New sidebar section "Chat UI"** with the open-chat header
  command — placeholder text for now, live status display planned.
- **Claude Code CLI version check & update flow.** New command
  `Claude Code: Check for Updates` (Extensions menu + sidebar header)
  surfaces the installed CLI version, compares it against the npm
  registry, and offers a one-click update with automatic bridge
  stop/restart.
- **Daily auto-check at activation**, throttled to 24h via
  `claudecode.updateCheck.lastCheckedAt`. Silent on success, notifies
  only when an update is available or when Claude Code is missing.
  Toggle via the new `claudecode.updateCheck.autoCheck` setting.
- **`stable` / `next` channel toggle** — `claudecode.updateCheck.channel`
  picks which npm `dist-tag` to compare against. `next` surfaces
  pre-releases; the comparator handles `X.Y.Z-beta.N` correctly (release
  sorts higher than pre-release per semver).
- **New sidebar section "Claude Code Version"** showing live state
  (up-to-date / update available / not installed / unknown / checking)
  with state-driven icon. Clicking the row triggers a check.
- **"Not installed" UX** — when the CLI is absent, the notification
  offers `Install Guide` (docs URL via `nova.openURL`),
  `Configure Path` (opens extension settings on
  `claudecode.claudeCommand`), `Install via npm` (only shown when `npm`
  is on PATH), and `Don't Show Again` (sets
  `claudecode.updateCheck.suppressNotInstalled`). The bridge keeps
  running — Claude Code is only required to launch the CLI from Nova.
- **Update execution prefers `claude update`** (the integrated updater),
  falls back to `npm update -g @anthropic-ai/claude-code` or
  `brew upgrade claude-code` based on the binary's resolved path. On
  failure, the bridge is left **not** restarted so the user stays in a
  stable state; a `Copy Log` action exposes stdout+stderr for triage.

### Internal
- New modules `Scripts/update-check.js` (~270 lines, pure logic — no
  Nova globals beyond `Process` / `fetch` / `nova.fs.stat`) and
  `Scripts/version-tree-provider.js` (~95 lines).
- New chat backend modules `Scripts/chat-session.mjs` (HTTP+WS server,
  SDK loop) and `Scripts/chat-tool-wrappers.mjs` (12 in-process tool
  wrappers). Static chat UI in `Scripts/chat-ui/` (HTML/CSS/JS, no
  build step ; marked + highlight.js via CDN for now).
- `Scripts/package.json` declares chat deps : `@anthropic-ai/claude-agent-sdk`,
  `ws`, `zod`. `node_modules/` ships ~50 MB unbundled ; esbuild
  bundling deferred to a later release.
- `Scripts/ws-server.js` extended : env-driven chat opt-in (`CC_CHAT_*`),
  shared `pendingRequests` map with `kind` dispatch, lazy
  `await import("./chat-session.mjs")` only when `chat.enabled=true`.
- Both `main.js` (root) and `Scripts/main.js` updated; require paths
  differ between the two (`./Scripts/…` vs `./…`) — only documented
  delta to keep them functionally identical. Added `resolveChatApiKey()`,
  `runOpRead()`, `openChatHandler()`, async `startBridge()`, and new
  `chat_started` / `chat_failed` server-message dispatch.
- Spike directories `spike/m0-node-pty/`, `spike/m1-agent-sdk/`,
  `spike/m2-chat-ui/` archived in-repo for reference. Each contains
  a `SPIKE.md` documenting findings ; `node_modules/` gitignored.

## 0.5.0 — 2026-05-15

### Changed
- **MCP tool schemas now match the VS Code / Neovim `PROTOCOL.md` spec
  verbatim.** Audited `tools/list` against
  [coder/claudecode.nvim/PROTOCOL.md](https://github.com/coder/claudecode.nvim/blob/main/PROTOCOL.md)
  (v0.3.0) and fixed four divergences so Claude Code CLI sends exactly
  what our bridge expects.

  | Tool | Before | After (spec) |
  |---|---|---|
  | `openFile` | `{filePath, lineNumber, selectText}` | `{filePath, preview, startText, endText, selectToEndOfLine, makeFrontmost}` |
  | `openDiff` | `{filePath, oldContent, newContent, tabName}` | `{old_file_path, new_file_path, new_file_contents, tab_name}` |
  | `getDiagnostics` | `{filePath}` | `{uri}` |
  | `closeAllDiffTabs` return | `{success, rejected}` object | `"CLOSED_${N}_DIFF_TABS"` plain string |

- **`openFile` output shape** now follows the spec: a plain `"Opened
  file: <path>"` string when `makeFrontmost=true` (default), versus the
  detailed JSON `{success, filePath, languageId, lineCount}` when
  `makeFrontmost=false`. `preview` is accepted but ignored (Nova has no
  preview mode).
- **`openFile` pattern-based selection** — `startText` / `endText` find
  positions in the document and select that range, optionally extended
  to end of line via `selectToEndOfLine`. Replaces the ad-hoc
  `lineNumber` parameter.
- **`openDiff` diff stats** are now computed against `old_file_path`
  (the original file on disk) and applied to `new_file_path` on Accept.
  Best-effort handling of rename-style diffs where the two paths
  differ.
- **`getDiagnostics`** returns the spec-shaped envelope
  `[{uri, diagnostics: []}]`. Always empty — Nova has no LSP /
  diagnostics public API — but the shape matches what Claude expects to
  deserialize.
- **Tool-result wire format** in `ws-server.js` now respects the
  handler's return type: plain strings flow through verbatim
  (`"TAB_CLOSED"`, `"FILE_SAVED"`, `"DIFF_REJECTED"`, …), objects are
  `JSON.stringify`-wrapped, and error results surface via the MCP
  `isError` flag.

### Added
- **`close_tab` tool** (`{tab_name}` → `"TAB_CLOSED"`) — Nova has no
  public close-tab API, so this is an honest no-op that still honors
  the protocol contract.
- **`executeCode` tool** (`{code}` → MCP error) — Jupyter kernel
  execution. Nova doesn't ship a notebook runtime, so the tool surfaces
  a clear `isError` response (`"executeCode is not supported in Nova
  (no Jupyter kernel)"`) rather than silently no-op'ing.

### Notes
- Breaking change for any non-Claude consumer of the bridge's
  `tools/list`. The only known consumer is Claude Code CLI itself
  (which sends the spec names), so this should be net positive in
  practice.
- `Scripts/call-bridge.js` examples updated to reflect the new param
  names.
- No changes to the lock-file format, auth header
  (`x-claude-code-ide-authorization`), or notification methods
  (`selection_changed` / `at_mentioned`) — those were already
  spec-conforming after v0.4.0.

## 0.4.1 — 2026-05-15

### Fixed
- **Sidebar icon now renders in the left sidebar stack** — Nova resolves
  `sidebars.smallImage` / `sidebars.largeImage` as a *folder* under
  `Images/` containing `<name>.png`, `<name>@2x.png`, and `metadata.json`
  with `{"template": true}`. The previous flat PNGs were never detected,
  so no icon appeared. Replaced with a monochrome anti-aliased "C"
  template image (Nova tints it per-theme).

### Added
- **`Scripts/gen-icon.py`** — regenerates the sidebar icon at the four
  Nova-standard sizes (small 16/32, large 24/48) into the expected
  folder layout. Pure-stdlib Python (no PIL/cairo), so it runs without
  external deps. Tweak the `outer` / `inner` / `gap` constants in
  `render_c()` to adjust the stroke thickness and opening angle.

## 0.4.0 — 2026-05-07

### Fixed
- **`Add Current File to Claude` actually attaches the file** — emits the
  proper `at_mentioned` notification matching the Neovim/VS Code protocol
  (`{filePath}` for whole files, no `lineStart`/`lineEnd`). Previously it
  only sent a `selection_update` with `(0, 0)` line range, which Claude
  interpreted as "0 lines selected" and truncated the context.
- **`selection_changed` notification format** — method renamed from
  `notifications/selectionChanged` (which Claude silently ignored) to
  `selection_changed`, and the payload reshaped to the nested
  `{text, filePath, fileUrl, selection: {start: {line, character}, end:
  {…}, isEmpty}}` structure expected by Claude Code clients. The
  selection-tracking feature now actually works on the Claude side.
- **`Send Selection to Claude` also at-mentions the range** — alongside
  the existing selection broadcast, the command now emits
  `at_mentioned` with `lineStart`/`lineEnd` so Claude's REPL shows the
  same `@file:lines` reference the user would type by hand.
- **`Launch Claude Code` finds Terminal.app on modern macOS** —
  `isAppInstalled()` now also checks `/System/Applications/Utilities/`
  and `/Applications/Utilities/`. Ships in macOS Catalina+ in the
  system path; the previous `/Applications/` + `~/Applications/` lookup
  always missed it on stock systems.
- **`clipboard` entitlement declared in manifest** — required for
  `Launch Claude Code` to copy the command in clipboard mode (and the
  fallback when no supported terminal is detected). Without it, the
  command threw `Extension does not declare the entitlement for
  clipboard access`.
- **Removed stale `Scripts/main.js` orphan** — a v0.1.0 entry-point
  copy left behind during an earlier refactor was being loaded by Nova
  in preference to the root `main.js` declared by `"main"` in the
  manifest. Symptoms: Activity panel stuck on the placeholder text,
  `claudecode.launchClaude` reported as "command not found", `⌘⌃A`
  silent-no-op. Nova ignores `extension.json:main` and looks for
  `Scripts/main.js` first; this version keeps both files in sync as
  the workaround until Panic clarifies the loader behaviour.

### Notes
- No new MCP tools; the change is in IDE → Claude notifications, not
  in `tools/list`. Existing clients keep working.
- The `selection_changed` rename is a wire-format break vs 0.3.0 but
  matches the documented Neovim/VS Code protocol and what Claude Code
  CLI actually consumes — 0.3.0's emission was effectively a no-op on
  Claude's side anyway.

## 0.3.0 — 2026-04-30

### Added
- **Real line/column numbers in selections** — `getCurrentSelection`,
  `getLatestSelection`, and live `selection_update` payloads now expose
  0-indexed `startLine` / `endLine` / `startColumn` / `endColumn`
  computed from the document offset (was hardcoded to 0). The
  `selection_sent` activity events render as `(L42-L58)` in the
  sidebar.
- **Git branch in context** — current branch is cached via
  `git rev-parse --abbrev-ref HEAD` (refreshed on bridge start and
  every 5 minutes) and shipped in every `selection_update` and
  `getWorkspaceFolders` response. Silently null outside git repos.
- **Diff line stats** — every `openDiff` computes a lightweight
  `+N / -M lines` delta (multiset line intersection vs. the file on
  disk; detects new files) and surfaces it in the system notification,
  the Pending Diffs sidebar label, the row tooltip, and the details
  dialog.
- **Pending Diffs tooltip preview** — hovering a diff row now shows
  the first 5 lines of the proposed content with an overflow marker.
- **Activity log persistence** — `activityLog` and `toolCallLog` are
  serialized to `globalStoragePath/activity.json` (debounced 1s) and
  restored on activate. `pendingDiffs` are intentionally not persisted
  (their Claude-side `requestId`s die with the session).
- **`claudecode.diffTimeoutMinutes`** setting (default 30, 0 disables)
  — auto-rejects pending diffs older than the threshold via the
  existing 30s sidebar tick. Stops dead `requestId`s from piling up
  when Claude crashes mid-flow.
- **`Restart Claude Code Bridge`** command (`claudecode.restart`) —
  stop + 300ms + start, useful after changing the port range or the
  Node.js path.
- **Default keyboard shortcuts**:
  - `Cmd+Ctrl+L` → Send Selection to Claude (when a selection exists)
  - `Cmd+Ctrl+A` → Add Current File to Claude
  Avoids `Cmd+Shift+L` which Nova already uses for "Reveal in Files
  Sidebar".
- **`claudecode.claudeArgs`** per-workspace setting — extra arguments
  appended after the Claude command in `Launch Claude Code`. Unlocks
  `--continue`, `--model claude-opus-4-7`,
  `--dangerously-skip-permissions`, etc. without code changes.
- **Auto-save before `Send Selection to Claude`** — if the document is
  dirty, it's saved first so Claude's disk-reading tools (Read, Bash)
  see the same content as the buffer.

### Fixed
- **`closeAllDiffTabs` no longer leaks pending diffs** — the tool now
  rejects every still-pending diff via `resolveDiff(id, false)` before
  sweeping the temp-file directory, freeing Claude-side `requestId`s
  that would otherwise wait forever. The Nova editor tabs themselves
  still need a manual `Cmd+W` (no public tab-close API in Nova).

### Notes
- No protocol changes; `ws-server.js` is untouched.
- All payload additions are additive — existing Claude Code clients
  will simply ignore the new fields (`gitBranch`, `startLine`,
  `endLine`, …).

## 0.2.1 — 2026-04-29

### Changed
- **Identifier renamed** from `com.marcbourget.claudecode-nova` to
  `ca.okapi.claudecode-nova` to match the `okapi-ca` organization
  registered on the Panic Extension Library. Required for marketplace
  publication — Panic ties extensions to a registered organization
  via the reverse-DNS prefix of the identifier, and the `com.marcbourget`
  prefix had no corresponding org. Organization metadata in the manifest
  was updated from `"Marc Bourget"` to `"okapi-ca"` for the same reason.
- **Side-effect on local installs**: Nova treats the new identifier as
  a different extension. Anyone who previously installed v0.2.0 from
  source under `com.marcbourget.claudecode-nova/` should remove that
  directory and copy the new bundle to `ca.okapi.claudecode-nova/`,
  otherwise both versions cohabit and the bridge port allocation can
  collide.

## 0.2.0 — 2026-04-29

### Added
- **Sidebar activity tracking** — two new sections under the Claude Code
  sidebar mirror what the VS Code v2.1.69+ activity panel shows:
  - **Pending Diffs** — every diff Claude proposes appears with its file
    name and a relative timestamp. Each diff has Accept / Reject child
    items so you can resolve from the sidebar without going through
    the system notification. Notifications are still emitted (3A) so
    the first diff still attracts attention; the sidebar is the
    multi-diff overflow path.
  - **Activity** — file opens, saves, sends-to-context, file-added-to-
    context, and diff outcomes appear at the top with timestamps that
    auto-refresh every 30s. Below them, a collapsible "Tool Calls (N)"
    group exposes every raw MCP tool invocation for debugging.
- **Click-through on activity items**:
  - File operations (`opened`, `saved`, `added`, `selection_sent`) →
    open the file in Nova
  - Diff events → details dialog with timestamp, length, and Open /
    Accept / Reject buttons
- Five new commands wired internally for the sidebar (not in the
  Extensions menu): `claudecode.activityClick`,
  `claudecode.activityClear`, `claudecode.diffAccept`,
  `claudecode.diffReject`, `claudecode.diffShowDetails`,
  `claudecode.sidebarRefresh`.
- "Launch Claude Code" command now **opens Claude in a real terminal**
  instead of just copying a command to the clipboard. Driven via
  AppleScript so the workspace cwd and the IDE-bridge env vars
  (`CLAUDE_CODE_SSE_PORT`, `ENABLE_IDE_INTEGRATION=true`) are pre-set
  — no manual paste, no `/ide` typing required, the bridge connects
  automatically.
- New global setting `claudecode.terminalApp` (enum):
  - `auto` (default) — iTerm2 if installed, otherwise Terminal.app
  - `iTerm` — iTerm2, opens a new tab in the current window
  - `Terminal` — Terminal.app, opens a new window
  - `clipboard` — keep the v0.1.x copy-to-clipboard behaviour
- **`Scripts/call-bridge.js`** — standalone CLI client for debugging
  and scripting. The Claude Code CLI only forwards
  `mcp__ide__getDiagnostics` to the model side; the other 9 tools
  registered by `ws-server.js` are consumed internally by the CLI
  and unreachable from a model conversation. This script connects
  to the running bridge directly via the lock file and invokes any
  tool by name. No npm dependencies — manual WebSocket framing
  mirrors `ws-server.js`. See README §Direct Tool Invocation.

### Fixed
- **RFC 6455 handshake** — the `Sec-WebSocket-Accept` calculation
  used a transposed magic GUID (`…-5AB5DC11CE56` instead of
  `…-C5AB0DC85B11`), so any RFC-compliant client computed a
  different digest and closed the connection right after the 101.
  Symptom: `read ECONNRESET` ~5 ms after "Claude Code client
  connected" in the Nova extension console with Claude CLI v2.1.x
  (which uses the `ws` Node.js library). Without this fix the
  bridge was effectively unusable on recent Claude CLI builds.
- **WebSocket subprotocol echo** — `ws-server.js` now echoes back
  the first offered `Sec-WebSocket-Protocol` (Claude CLI sends
  `mcp`). Strict clients reject the connection if a requested
  subprotocol is not selected by the server.
- **Disconnect logging** — the close-event `hadError` flag is now
  surfaced in the extension console so future handshake regressions
  are visible at a glance.

### Changed
- `openDiff` was refactored: pendingDiffs is now the source of truth.
  The notification handler and the sidebar Accept/Reject commands both
  call the same `resolveDiff(id, accepted)` function. Idempotent —
  resolving a diff a second time is a no-op, so race conditions
  between the notification and the sidebar are harmless.

### Notes
- Other terminals (Warp, Ghostty, Hyper, kitty, Alacritty) lack a
  reliable AppleScript control surface and fall back to the clipboard
  path. Pick `clipboard` explicitly to silence the auto-detect.
- If the configured terminal isn't installed at launch time, the
  extension falls back to clipboard automatically and notifies the user.
- Activity buffers are bounded: 50 visible events, 100 raw tool calls.
  Older entries roll off — there is no persistence across Nova restarts.

## 0.1.1 — 2026-04-29

### Fixed
- `openDiff` now respects edits the user made in the proposed-changes tab
  before clicking *Accept*. Previously the original `newContent` from Claude
  was always written to disk, silently discarding any in-IDE edits.

### Changed
- `openDiff` response payload now carries `userEdited: true` and
  `finalContent` when the saved file differs from Claude's original proposal.
  This mirrors the v2.1.110 Claude Code CLI behaviour where the model is
  informed of edits the user made before accepting (see CLI changelog
  2026-03 entry).
- `closeAllDiffTabs` MCP description corrected to reflect what it actually
  does on Nova: cleans up temporary `proposed_*` files in extension storage.
  Nova exposes no public API to programmatically close editor tabs, so the
  prior wording ("Close all open diff views") was misleading.

### Investigated, not implemented
- `close_tab` and `executeCode` (added to `claudecode.nvim` PROTOCOL.md as
  the canonical 12-tool list) are **not implementable** on Nova:
  - `close_tab`: Nova has no public tab-management API
    (`TextEditor`/`Workspace` expose no `close()` method, no command, no
    keyboard-shortcut surface for extensions).
  - `executeCode`: Nova has no Jupyter kernel integration.
  Neither tool is advertised in our `tools/list` response — Claude will
  not call them on Nova.

## 0.1.0 — 2026-02-26

- Initial release
- WebSocket MCP server bridge via Node.js subprocess
- MCP tools: openFile, openDiff, getCurrentSelection, getLatestSelection, getOpenEditors, getWorkspaceFolders, checkDocumentDirty, saveDocument, getDiagnostics, closeAllDiffTabs
- Real-time selection tracking
- Sidebar status panel
- Lock file discovery mechanism for Claude Code CLI
