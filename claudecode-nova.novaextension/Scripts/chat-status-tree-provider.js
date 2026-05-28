/**
 * chat-status-tree-provider.js — single-row TreeDataProvider for the
 * "Chat UI Status" sidebar section. Surfaces the lifecycle of the chat
 * server (Mode B) so the user can see at a glance whether it's running,
 * which port + model are in use, and where the API key came from.
 *
 * State shape (mutated by main.js, read here):
 *   {
 *     state: "disabled" | "no_key" | "starting" | "running" |
 *            "failed" | "stopped",
 *     port: number | null,
 *     model: string | null,
 *     apiKeySource: "keychain" | "1password" | "config" | null,
 *     lastError: string | null,
 *     url: string | null,
 *     lastUpdatedAt: number | null,
 *   }
 *
 * main.js keeps a reference to the state, mutates it on chat_started /
 * chat_failed / process exit, and calls treeView.reload() to refresh.
 */

class ChatStatusTreeProvider {
  constructor(state) {
    this.state = state;
  }

  getChildren(element) {
    if (!element) return [{ kind: "chat-status" }];
    return [];
  }

  getTreeItem(element) {
    const s = this.state;
    const item = new TreeItem(formatLabel(s));
    item.identifier = "claudecode-chat-status";
    item.descriptiveText = formatDescriptive(s);
    item.tooltip = formatTooltip(s);
    item.image = pickImage(s);
    item.command = "claudecode.openChat";
    return item;
  }
}

function formatLabel(s) {
  switch (s.state) {
    case "disabled":   return "Chat UI: disabled";
    case "no_key":     return "Chat UI: missing API key";
    case "starting":   return "Chat UI: starting…";
    case "running":    return "Chat UI: running on port " + (s.port || "?");
    case "failed":     return "Chat UI: failed to start";
    case "stopped":    return "Chat UI: stopped";
    default:           return "Chat UI: unknown";
  }
}

function formatDescriptive(s) {
  if (s.state === "running" && s.model) {
    return modeLabel(s.apiKeySource) + " · " + s.model;
  }
  if (s.state === "starting") return modeLabel(s.apiKeySource);
  if (s.state === "disabled") return "Enable in settings";
  if (s.state === "no_key") return "Configure API key";
  if (s.state === "failed") return "Click to see details";
  if (s.state === "stopped") return "";
  return "";
}

// Short label for the auth/runtime mode. The chat backend picks between
// the Anthropic SDK (with an API key) and a `claude` CLI subprocess
// fallback (OAuth Pro/Max session, no key needed).
function modeLabel(apiKeySource) {
  if (apiKeySource === "claude-cli") return "CLI";
  if (apiKeySource) return "SDK";
  return "";
}

function formatTooltip(s) {
  const lines = [];
  switch (s.state) {
    case "running":
      lines.push("Status: running");
      if (s.url) lines.push("URL: " + s.url);
      if (s.model) lines.push("Model: " + s.model);
      if (s.apiKeySource === "claude-cli") {
        lines.push("Auth: Claude Code CLI session (OAuth Pro/Max — no API key)");
      } else if (s.apiKeySource) {
        lines.push("Auth: Anthropic SDK — key from " + s.apiKeySource);
      }
      lines.push("Click to open / copy URL.");
      break;
    case "disabled":
      lines.push("Chat UI is not enabled.");
      lines.push("Toggle 'Enable Chat UI' in Extension Settings.");
      break;
    case "no_key":
      lines.push("Chat is enabled but no Anthropic API key was resolved.");
      lines.push("Configure the Keychain entry, 1Password reference, or direct key in settings.");
      break;
    case "starting":
      lines.push("Chat server is starting…");
      break;
    case "failed":
      lines.push("Chat server failed to start.");
      if (s.lastError) lines.push("Error: " + s.lastError);
      lines.push("Common cause: port " + (s.port || "5180") + " is already in use by a zombie process.");
      break;
    case "stopped":
      lines.push("Chat server is stopped.");
      lines.push("Restart the bridge to bring it back.");
      break;
    default:
      lines.push("Chat UI status unknown.");
  }
  if (s.lastUpdatedAt) {
    lines.push("");
    lines.push("Updated: " + new Date(s.lastUpdatedAt).toLocaleString());
  }
  return lines.join("\n");
}

function pickImage(s) {
  switch (s.state) {
    case "running":    return "__builtin.info";
    case "starting":   return "__builtin.refresh";
    case "failed":     return "__builtin.error";
    case "no_key":     return "__builtin.warning";
    case "disabled":   return "__builtin.warning";
    case "stopped":    return "__builtin.info";
    default:           return "__builtin.info";
  }
}

module.exports = { ChatStatusTreeProvider };
