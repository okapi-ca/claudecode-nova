// Test 4 — test3 + auto-approval des tools Nova via allowedTools.
//
// Test3 a prouvé que les mitigations (model, tools, settingSources) réduisent
// le coût de 77× et restreignent l'inventaire. Mais le SDK demande encore une
// permission user avant chaque tool call — comportement par défaut du CLI
// Claude Code. Pour notre chat UI, nos tools Nova sont de confiance (on les a
// définis nous-mêmes), donc on les auto-approuve via `allowedTools`.
//
// Si ce test passe, la config est production-ready pour le sprint Chat UI.
//
// Usage :
//   export ANTHROPIC_API_KEY=$(op read "op://Private/Anthropic API Key/credential")
//   node test4-approved.mjs

import { query, tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

if (!process.env.ANTHROPIC_API_KEY) {
  console.error("ERROR: set ANTHROPIC_API_KEY env var before running.");
  process.exit(1);
}

console.log("─".repeat(60));
console.log(" M1 Test 4 — auto-approved Nova tools (production-ready config)");
console.log("─".repeat(60));

const fakeWorkspace = {
  "src/auth.ts": `export function login(user: string, pwd: string) {
  // FIXME: hardcoded admin bypass — security issue
  if (user === "admin") return { ok: true };
  return checkCredentials(user, pwd);
}`,
  "README.md": "# Project\n\nThis is a fake project for the M1 spike.",
};

const novaOpenFile = tool(
  "nova_openFile",
  "Open and read the contents of a file in the Nova editor workspace.",
  {
    path: z.string().describe("Relative path to the file from the workspace root"),
  },
  async (args) => {
    console.log(`\n[tool:nova_openFile] called with path="${args.path}"`);
    await new Promise((r) => setTimeout(r, 50));
    const content = fakeWorkspace[args.path];
    if (content === undefined) {
      return {
        content: [{ type: "text", text: `Error: file not found: ${args.path}` }],
        isError: true,
      };
    }
    return { content: [{ type: "text", text: content }] };
  },
);

const novaListFiles = tool(
  "nova_listFiles",
  "List all files in the Nova workspace.",
  {},
  async () => {
    console.log(`\n[tool:nova_listFiles] called`);
    await new Promise((r) => setTimeout(r, 50));
    return {
      content: [{ type: "text", text: Object.keys(fakeWorkspace).join("\n") }],
    };
  },
);

const novaServer = createSdkMcpServer({
  name: "nova",
  version: "0.0.0",
  tools: [novaOpenFile, novaListFiles],
});

const prompt = "List the files in the workspace, then read src/auth.ts and tell me if there are any security issues. Keep your response under 100 words.";

console.log("\n[user]", prompt, "\n");

const startedAt = Date.now();
const counts = {};
const toolCalls = [];
const toolHandlerCalls = [];
let toolsAvailableCount = null;

// Wrap les handlers pour observer s'ils sont vraiment exécutés (vs juste appelés
// par Claude mais bloqués par les permissions du SDK)
const originalListHandler = novaListFiles.handler;
const originalOpenHandler = novaOpenFile.handler;
novaListFiles.handler = async (...args) => {
  toolHandlerCalls.push({ name: "nova_listFiles", args: args[0] });
  return originalListHandler(...args);
};
novaOpenFile.handler = async (...args) => {
  toolHandlerCalls.push({ name: "nova_openFile", args: args[0] });
  return originalOpenHandler(...args);
};

const q = query({
  prompt,
  options: {
    model: "claude-sonnet-4-6",
    tools: [],
    settingSources: [],
    mcpServers: { nova: novaServer },

    // CHANGEMENT vs test3 — auto-approve nos tools Nova de confiance.
    // Wildcard "mcp__nova__*" couvre tous les tools du serveur "nova".
    allowedTools: ["mcp__nova__nova_listFiles", "mcp__nova__nova_openFile"],
  },
});

for await (const msg of q) {
  counts[msg.type] = (counts[msg.type] || 0) + 1;

  switch (msg.type) {
    case "system":
      if (msg.subtype === "init") {
        toolsAvailableCount = msg.tools?.length ?? null;
        console.log(`[system:init] session=${msg.session_id?.slice(0, 8)}… model=${msg.model}`);
        console.log(`[system:init] tools available: ${toolsAvailableCount}`);
      }
      break;

    case "assistant": {
      const content = msg.message?.content ?? [];
      for (const block of content) {
        if (block.type === "text") {
          process.stdout.write(block.text);
        } else if (block.type === "tool_use") {
          console.log(`\n[assistant→tool_use] ${block.name}(${JSON.stringify(block.input)})`);
          toolCalls.push({ name: block.name, input: block.input });
        }
      }
      break;
    }

    case "user": {
      const content = msg.message?.content ?? [];
      for (const block of content) {
        if (block.type === "tool_result") {
          const text = Array.isArray(block.content)
            ? block.content.map((c) => c.text).join("")
            : block.content;
          const isPermissionDenied = typeof text === "string" && text.includes("haven't granted");
          const tag = isPermissionDenied ? "[tool_result:DENIED]" : "[tool_result]";
          console.log(`\n${tag} ${text?.slice(0, 100) ?? "(empty)"}${text?.length > 100 ? "…" : ""}`);
        }
      }
      break;
    }

    case "result": {
      const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
      console.log(`\n\n─ Result: ${msg.subtype}`);
      if (msg.subtype === "success") {
        if (msg.usage) {
          console.log(`─ Tokens: in=${msg.usage.input_tokens} out=${msg.usage.output_tokens}`);
        }
        if (msg.total_cost_usd != null) {
          console.log(`─ Cost: $${msg.total_cost_usd.toFixed(4)} USD`);
        }
      } else {
        console.log(`─ Error:`, msg);
      }
      console.log(`─ Elapsed: ${elapsed}s`);
      console.log(`─ Tool calls (assistant intent) : ${toolCalls.length}`);
      console.log(`─ Tool handlers (réellement exécutés) : ${toolHandlerCalls.length}`);
      break;
    }
  }
}

const handlersRan = toolHandlerCalls.length >= 1;
const allCallsResolved = toolHandlerCalls.length === toolCalls.length;

console.log("\n─ Évaluation finale :");
console.log(`    Tools dispo : ${toolsAvailableCount} ${toolsAvailableCount === 2 ? "✓" : "(attendu: 2)"}`);
console.log(`    Tools appelés par Claude : ${toolCalls.length}`);
console.log(`    Handlers exécutés (auto-approuvés) : ${toolHandlerCalls.length} ${handlersRan ? "✓" : "✗"}`);
console.log(`    Toutes les requêtes résolues : ${allCallsResolved ? "✓" : "✗"}`);

if (handlersRan && allCallsResolved) {
  console.log("\n─ ✅ Test 4 PASS — config production-ready pour le sprint Chat UI.");
  process.exit(0);
} else {
  console.log("\n─ ✗ Test 4 FAIL — auto-approval n'a pas fonctionné comme prévu.");
  console.log("─ Investigation à faire : wildcard non supporté ? canUseTool nécessaire ?");
  process.exit(1);
}
