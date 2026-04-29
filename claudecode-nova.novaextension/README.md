# Claude Code Bridge for Nova

> Integrate Claude Code CLI with [Nova](https://nova.app) (by Panic) through the WebSocket MCP protocol — the same protocol used by the official VS Code and JetBrains extensions.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Nova: 10+](https://img.shields.io/badge/Nova-10%2B-blueviolet)](https://nova.app)
[![Node: 18+](https://img.shields.io/badge/Node.js-18%2B-green)](https://nodejs.org)
[![Sponsor: LCI Education](https://img.shields.io/badge/Sponsor-LCI%20Education-orange)](https://www.lcieducation.com)

## Why?

Claude Code has official IDE integrations for VS Code and JetBrains, but nothing for Nova. If you love Nova's native macOS experience and want Claude Code's full agentic capabilities — context sharing, inline diffs, selection tracking — this extension bridges the gap.

The approach was pioneered by [coder/claudecode.nvim](https://github.com/coder/claudecode.nvim) for Neovim. This project brings the same idea to Nova using its JavaScript extension API.

## How It Works

```
┌──────────────────────────────────────────────────┐
│                   Nova Editor                     │
│                                                   │
│  ┌─────────────┐   JSON lines    ┌─────────────┐ │
│  │  main.js    │◄──────────────►│ ws-server.js │ │
│  │  (Extension)│  stdin/stdout   │ (Node.js     │ │
│  │             │                 │  subprocess) │ │
│  └──────┬──────┘                 └──────┬───────┘ │
│         │                               │         │
│    Nova APIs:                     WebSocket MCP   │
│    • TextEditor                   (RFC 6455)      │
│    • Workspace                          │         │
│    • NotificationCenter                 │         │
│    • FileSystem                         │         │
└─────────────────────────────────────────┼─────────┘
                                          │
                    ┌─────────────────────┘
                    │
                    ▼
          ┌─────────────────┐
          │  Claude Code CLI │
          │  (claude → /ide) │
          └─────────────────┘
```

The extension spawns a Node.js subprocess that runs a WebSocket server implementing the [MCP (Model Context Protocol)](https://modelcontextprotocol.io). Claude Code CLI discovers this server through a lock file at `~/.claude/ide/<port>.lock` — exactly the same mechanism used by the official extensions. All communication uses JSON-RPC 2.0 over WebSocket frames.

## Features

- **Automatic context sharing** — Claude Code sees your active file, selection, and workspace structure
- **Selection tracking** — Real-time selection broadcasts as you navigate and select code
- **Diff review** — Accept or reject Claude's proposed changes via notification prompts; user edits in the proposed-changes tab are preserved on Accept and signalled back to Claude
- **File operations** — Claude can open files, save documents, and check for unsaved changes
- **Sidebar tracking** — Three live sections: connection status, pending diffs queue with per-item Accept/Reject, and an activity log of file operations and diff outcomes (auto-refreshes every 30s)
- **One-click launch** — Open Claude Code in iTerm or Terminal.app with the IDE-bridge env vars pre-set; the bridge connects automatically
- **Secure by default** — Localhost-only WebSocket with UUID token authentication

## Requirements

| Dependency | Minimum Version |
|------------|----------------|
| [Nova](https://nova.app) | 10.0 |
| [Node.js](https://nodejs.org) | 18.0 |
| [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) | Latest |

## Installation

### From Source

```bash
git clone https://github.com/okapi-ca/claudecode-nova.git
cp -r claudecode-nova/claudecode-nova.novaextension \
  ~/Library/Application\ Support/Nova/Extensions/
```

### For Development

```bash
git clone https://github.com/okapi-ca/claudecode-nova.git
ln -s "$(pwd)/claudecode-nova/claudecode-nova.novaextension" \
  ~/Library/Application\ Support/Nova/Extensions/claudecode-nova.novaextension
```

Then enable Extension Development in Nova: **Preferences → General → Extension Development**.

## Quick Start

1. Open a project in Nova
2. The extension starts automatically (you'll see a notification)
3. Run the **Launch Claude Code** command from *Extensions → Claude Code Bridge* (or the Command Palette).
   - It opens Claude in your configured terminal (iTerm by default if installed, otherwise Terminal.app — see the `claudecode.terminalApp` setting) with the workspace cwd and IDE-bridge env vars already set.
   - The bridge connects automatically; no need to type `/ide`.
4. You'll see a "Connected" notification in Nova. Claude now has access to your editor context.

### Manual launch (alternative)

If you prefer to drive the terminal yourself, set `claudecode.terminalApp` to `clipboard` and run:

```bash
cd /your/project
CLAUDE_CODE_SSE_PORT=<port> ENABLE_IDE_INTEGRATION=true claude
```

The port is shown in the *Show Claude Code Status* command. Inside Claude, `/ide` triggers discovery if the env vars weren't picked up.

## Supported MCP Tools

These are the tools that Claude Code can invoke through the bridge, matching the protocol used by the official VS Code and JetBrains extensions:

| Tool | Status | Description |
|------|--------|-------------|
| `openFile` | ✅ Full | Open a file with optional line navigation |
| `openDiff` | ✅ Full | Diff via temp file + accept/reject notification. User edits in the proposed-changes tab are preserved on Accept and signalled back to Claude (see [Known Limitations §1](#known-limitations) for the side-by-side caveat). |
| `getCurrentSelection` | ✅ Full | Current editor selection with file path and range |
| `getLatestSelection` | ✅ Full | Most recently recorded selection |
| `getOpenEditors` | ✅ Full | List all open editor tabs with metadata |
| `getWorkspaceFolders` | ✅ Full | Workspace folder paths |
| `checkDocumentDirty` | ✅ Full | Check for unsaved changes in a file |
| `saveDocument` | ✅ Full | Save a document |
| `getDiagnostics` | ⚠️ Partial | Requires LSP extension cooperation (see Limitations) |
| `closeAllDiffTabs` | ⚠️ Best-effort | Removes our temporary `proposed_*` files; cannot close Nova editor tabs because Nova has no public tab-management API |
| `close_tab` | ❌ Not supported | Nova exposes no public API to close an editor tab — see [Known Limitations §6](#known-limitations). Not advertised in `tools/list`. |
| `executeCode` | ❌ Not supported | Nova has no Jupyter kernel integration. Not advertised in `tools/list`. |

## Direct Tool Invocation (debug helper)

The Claude Code CLI only forwards `mcp__ide__getDiagnostics` to the model — the other 9 tools registered by `ws-server.js` are consumed internally by the CLI and not callable from a model conversation. For debugging or scripting, `Scripts/call-bridge.js` connects to the running bridge directly via the lock file and invokes any tool by name. No npm dependencies.

```bash
SCRIPT="$HOME/Library/Application Support/Nova/Extensions/com.marcbourget.claudecode-nova/Scripts/call-bridge.js"
# (or wherever the extension is installed; for development use the project path)

node "$SCRIPT" --tools                         # list tools advertised by the bridge
node "$SCRIPT" getOpenEditors                  # call with empty args
node "$SCRIPT" getCurrentSelection
node "$SCRIPT" getWorkspaceFolders
node "$SCRIPT" openFile '{"filePath":"/abs/path","lineNumber":42}'
node "$SCRIPT" saveDocument '{"filePath":"/abs/path"}'
```

The script auto-discovers the lock file under `~/.claude/ide/`, preferring one whose `workspaceFolders` matches the current cwd when several Nova instances are running. Output is the unwrapped tool result as pretty-printed JSON; errors go to stderr with a non-zero exit code.

## Sidebar

The Claude Code sidebar exposes three sections:

```
▼ Claude Code
  ▼ Status
    ● Server Running
    Port: 12345
    Clients: 1
  ▼ Pending Diffs
    ▼ auth.ts                                      5s ago
      ✓  Accept
      ✗  Reject
    ▼ Button.tsx                                   1m ago
      ✓  Accept
      ✗  Reject
  ▼ Activity
    📄  Opened src/parser.ts                       just now
    💾  Saved README.md                            12s ago
    ✓  Accepted diff: components/Button.tsx       1m ago
    ✂️  Sent selection from src/types.ts           2m ago
    ✗  Rejected diff: middleware/cors.ts          5m ago
    ▶ Tool Calls (47)
```

- **Status** — connection state, port, client count. Header buttons start/stop the bridge.
- **Pending Diffs** — every diff Claude proposes is queued here with file name + age. Double-click *Accept* or *Reject* to resolve. Notifications still appear for the first diff (so it gets your attention); the sidebar handles multi-diff overflow. Double-click the parent item to see details with Open / Accept / Reject buttons.
- **Activity** — visible-effect events (file opens/saves, selections sent, diff outcomes). Click an item to open the corresponding file (file ops) or see a details dialog (diff ops). The collapsible *Tool Calls* group at the bottom shows the raw MCP traffic for debugging — including the bookkeeping calls Claude makes constantly (`getCurrentSelection`, `getOpenEditors`, …).
- Buffers are bounded (50 activity events, 100 tool calls). Header *Refresh* re-renders, *Clear* empties both buffers. Auto-refresh every 30 s keeps relative timestamps accurate.

## Commands

Access these from **Extensions → Claude Code Bridge** or the Command Palette:

| Command | Description |
|---------|-------------|
| Start Claude Code Bridge | Start the WebSocket MCP server |
| Stop Claude Code Bridge | Stop the server and disconnect clients |
| Send Selection to Claude | Push the current selection as context |
| Add Current File to Claude | Send the entire active file as context |
| Show Claude Code Status | Display connection status and server info |
| Launch Claude Code (with IDE integration) | Open Claude Code in your terminal of choice (iTerm or Terminal) with the IDE bridge env vars pre-set. Falls back to clipboard for unsupported terminals — see `claudecode.terminalApp` setting. |

## Configuration

### Global Preferences

| Key | Default | Description |
|-----|---------|-------------|
| `claudecode.portMin` | `10000` | Minimum port for the WebSocket server |
| `claudecode.portMax` | `65535` | Maximum port |
| `claudecode.autoStart` | `true` | Start the bridge automatically on activation |
| `claudecode.trackSelection` | `true` | Broadcast selection changes in real time |
| `claudecode.nodePath` | `node` | Path to the Node.js executable |
| `claudecode.terminalApp` | `auto` | Where the *Launch Claude Code* command opens the CLI: `auto` (iTerm if installed, else Terminal), `iTerm`, `Terminal`, or `clipboard` (just copy the command). Other terminals (Warp, Ghostty, Hyper) fall back to clipboard automatically. |

### Per-Project Settings

| Key | Default | Description |
|-----|---------|-------------|
| `claudecode.claudeCommand` | `claude` | Command to launch Claude Code CLI |

## Known Limitations

The following limitations exist due to Nova's extension API boundaries:

1. **Diff viewer** — Nova does not expose a native diff API like VS Code's `vscode.diff`. Proposed changes are shown by opening a temporary file alongside the original, with an accept/reject notification. Edits the user makes in the proposed-changes tab before clicking *Accept* are preserved (the actual content of the temp file is what gets saved) and signalled back to Claude via `userEdited: true` in the response. A future version may leverage Nova's built-in Git comparison view for side-by-side rendering.

2. **Diagnostics** — Nova does not provide a global API for reading LSP diagnostics from third-party extensions. The `getDiagnostics` tool currently returns an empty list. Full support would require cooperation with language server extensions or a shared `IssueCollection`.

3. **No native WebSocket server** — Nova's JavaScript runtime does not include `WebSocket` server or raw TCP socket APIs. The workaround is a Node.js subprocess, which adds a dependency but works reliably.

4. **No HTTP preview integration** — Nova's built-in web preview is not accessible through the extension API, so Claude cannot interact with the preview pane.

5. **Selection line numbers** — Nova's `Range` is character-offset based. Line number mapping in selection tracking is approximate. A future version will use `TextDocument` line-counting methods for precise ranges.

6. **No tab-management API** — Nova exposes no method on `TextEditor` or `Workspace` to close an editor tab from an extension. As a consequence:
   - `close_tab` (tool 11 in [claudecode.nvim PROTOCOL.md](https://github.com/coder/claudecode.nvim/blob/main/PROTOCOL.md)) is **not advertised** in our `tools/list` — Claude will not call it.
   - `closeAllDiffTabs` only removes the temporary `proposed_*` files staged in extension storage; the corresponding tabs in Nova remain open until the user closes them manually (Cmd+W).
   - Confirmed by the [Tabs Sidebar extension](https://extensions.panic.com/extensions/austenblokker/austenblokker.TabsSidebar/), which documents the same limitation.

7. **No Jupyter kernel integration** — `executeCode` (tool 12 in PROTOCOL.md) is unsupported. Nova does not expose a notebook runtime, and exposing one would be a separate product. Not advertised in `tools/list`.

## Architecture

```
claudecode-nova.novaextension/
├── extension.json          # Extension manifest (commands, sidebar, config)
├── Scripts/
│   ├── main.js             # Nova entry point — editor API bridge
│   ├── ws-server.js        # WebSocket MCP server (Node.js subprocess)
│   └── call-bridge.js      # Standalone CLI client for invoking bridge tools
├── Images/
│   ├── claude-icon-small.png
│   ├── claude-icon-large.png
│   └── ...@2x variants
└── README.md
```

### Communication Flow

1. Nova extension (`main.js`) spawns `ws-server.js` as a child process
2. `ws-server.js` binds a WebSocket server on `127.0.0.1:<random_port>`
3. A lock file is written to `~/.claude/ide/<port>.lock` with connection info
4. Claude Code CLI discovers the lock file via `/ide` command
5. CLI connects to the WebSocket, authenticates with the UUID token
6. MCP tool calls arrive as JSON-RPC 2.0 requests over WebSocket
7. `ws-server.js` forwards them to `main.js` via stdout JSON lines
8. `main.js` executes the tool using Nova APIs and sends the result back via stdin
9. `ws-server.js` wraps the result in MCP format and returns it over WebSocket

### Lock File Format

```json
{
  "port": 12345,
  "authToken": "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d",
  "version": "0.2.0",
  "ideName": "Nova",
  "ideVersion": "1.0.0",
  "workspaceFolders": ["/Users/you/project"],
  "pid": 54321
}
```

### Security

- WebSocket server binds to `127.0.0.1` only (no network exposure)
- Every connection requires the UUID auth token in the `x-claude-code-ide-authorization` header
- Lock files are removed on clean shutdown
- No data leaves your machine — all communication is local IPC

## Roadmap

### v0.2.0 (shipped)
- [x] One-click launch into iTerm or Terminal.app with IDE env vars pre-set
- [x] User edits in the proposed-changes tab are preserved on Accept and signalled to Claude (`userEdited` / `finalContent`)
- [x] Sidebar with Pending Diffs queue (per-item Accept/Reject) and Activity log (visible-effect events + raw tool-call group)
- [ ] Improved diff view with side-by-side file comparison
- [ ] Diagnostics integration via shared IssueCollection
- [ ] Accurate line number tracking in selections

### v0.3.0
- [ ] Warp / Ghostty / Hyper launch support (URL-scheme or wrapper-script approach)
- [ ] Configurable keyboard shortcuts
- [ ] Multi-workspace support
- [ ] File watcher for external changes

### v1.0.0
- [ ] Full MCP protocol v2 compatibility
- [ ] Automated test suite
- [ ] Publication on [extensions.panic.com](https://extensions.panic.com)
- [ ] Proper icon set

## Contributing

Contributions are welcome! This project exists because the community (notably [coder/claudecode.nvim](https://github.com/coder/claudecode.nvim)) proved that third-party IDE integrations with Claude Code are fully achievable.

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-thing`)
3. Commit your changes (`git commit -m 'Add amazing thing'`)
4. Push to the branch (`git push origin feature/amazing-thing`)
5. Open a Pull Request

### Development Tips

- Enable Nova's Extension Console: **Extensions → Show Extension Console**, filter by source
- The `ws-server.js` subprocess logs are piped through — check the console for both layers
- Use `claude --ide` from an external terminal to test connections
- The [PROTOCOL.md](https://github.com/coder/claudecode.nvim/blob/main/PROTOCOL.md) from claudecode.nvim is the definitive protocol reference

## Credits

- **Author**: [Marc Bourget](https://github.com/okapi-ca) — CISSP, Principal Director of Cybersecurity
- **Sponsor**: [LCI Education](https://www.lcieducation.com) — An international educational community of 12 higher education institutions across 17 campuses on 5 continents. LCI Education supports open-source initiatives and encouraged the public release of this project.
- **Protocol reverse engineering**: [coder/claudecode.nvim](https://github.com/coder/claudecode.nvim) by Thomas Kosiewski and contributors
- **Nova Extension API**: [docs.nova.app](https://docs.nova.app/)
- **Claude Code**: [Anthropic](https://anthropic.com)

## Sponsor

<p align="center">
  <a href="https://www.lcieducation.com">
    <strong>LCI Education</strong>
  </a>
  <br/>
  <em>Proudly supporting open-source development</em>
  <br/><br/>
  LCI Education is an international educational community comprising 12 higher education institutions<br/>
  operating across 17 campuses on 5 continents, dedicated to accessible, quality education worldwide.
</p>

## License

MIT — See [LICENSE](LICENSE) for details.
