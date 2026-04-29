# Changelog

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
