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
- **Diff review** — Accept or reject Claude's proposed changes via notification prompts
- **File operations** — Claude can open files, save documents, and check for unsaved changes
- **Sidebar status** — See connection state at a glance
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
3. Open a terminal (inside Nova or externally) and navigate to your project:
   ```bash
   cd /your/project
   claude
   ```
4. Inside Claude Code, type:
   ```
   /ide
   ```
5. Claude Code discovers Nova and connects ✓

You should see a "Connected" notification in Nova. Claude now has access to your editor context.

## Supported MCP Tools

These are the tools that Claude Code can invoke through the bridge, matching the protocol used by the official VS Code and JetBrains extensions:

| Tool | Status | Description |
|------|--------|-------------|
| `openFile` | ✅ Full | Open a file with optional line navigation |
| `openDiff` | ✅ Basic | Diff via temp file + accept/reject notification |
| `getCurrentSelection` | ✅ Full | Current editor selection with file path and range |
| `getLatestSelection` | ✅ Full | Most recently recorded selection |
| `getOpenEditors` | ✅ Full | List all open editor tabs with metadata |
| `getWorkspaceFolders` | ✅ Full | Workspace folder paths |
| `checkDocumentDirty` | ✅ Full | Check for unsaved changes in a file |
| `saveDocument` | ✅ Full | Save a document |
| `getDiagnostics` | ⚠️ Partial | Requires LSP extension cooperation (see Limitations) |
| `closeAllDiffTabs` | ✅ Full | Clean up temporary diff files |

## Commands

Access these from **Extensions → Claude Code Bridge** or the Command Palette:

| Command | Description |
|---------|-------------|
| Start Claude Code Bridge | Start the WebSocket MCP server |
| Stop Claude Code Bridge | Stop the server and disconnect clients |
| Send Selection to Claude | Push the current selection as context |
| Add Current File to Claude | Send the entire active file as context |
| Show Claude Code Status | Display connection status and server info |

## Configuration

### Global Preferences

| Key | Default | Description |
|-----|---------|-------------|
| `claudecode.portMin` | `10000` | Minimum port for the WebSocket server |
| `claudecode.portMax` | `65535` | Maximum port |
| `claudecode.autoStart` | `true` | Start the bridge automatically on activation |
| `claudecode.trackSelection` | `true` | Broadcast selection changes in real time |
| `claudecode.nodePath` | `node` | Path to the Node.js executable |

### Per-Project Settings

| Key | Default | Description |
|-----|---------|-------------|
| `claudecode.claudeCommand` | `claude` | Command to launch Claude Code CLI |

## Known Limitations

This is a v0.1.0 MVP. The following limitations exist due to Nova's extension API boundaries:

1. **Diff viewer** — Nova does not expose a native diff API like VS Code's `vscode.diff`. Proposed changes are shown by opening a temporary file alongside the original, with an accept/reject notification. A future version may leverage Nova's built-in Git comparison view.

2. **Diagnostics** — Nova does not provide a global API for reading LSP diagnostics from third-party extensions. The `getDiagnostics` tool currently returns an empty list. Full support would require cooperation with language server extensions or a shared `IssueCollection`.

3. **No native WebSocket server** — Nova's JavaScript runtime does not include `WebSocket` server or raw TCP socket APIs. The workaround is a Node.js subprocess, which adds a dependency but works reliably.

4. **No HTTP preview integration** — Nova's built-in web preview is not accessible through the extension API, so Claude cannot interact with the preview pane.

5. **Selection line numbers** — Nova's `Range` is character-offset based. Line number mapping in selection tracking is approximate. A future version will use `TextDocument` line-counting methods for precise ranges.

## Architecture

```
claudecode-nova.novaextension/
├── extension.json          # Extension manifest (commands, sidebar, config)
├── Scripts/
│   ├── main.js             # Nova entry point — editor API bridge
│   └── ws-server.js        # WebSocket MCP server (Node.js subprocess)
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

### v0.2.0
- [ ] Improved diff view with side-by-side file comparison
- [ ] Diagnostics integration via shared IssueCollection
- [ ] Enriched sidebar with Claude action history
- [ ] Accurate line number tracking in selections

### v0.3.0
- [ ] Launch Claude Code from within Nova (integrated terminal)
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
