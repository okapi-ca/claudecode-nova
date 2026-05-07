# Changelog

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
