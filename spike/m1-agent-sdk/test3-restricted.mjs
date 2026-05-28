// Test 3 — query restreinte : 4 mitigations cumulées pour coût + isolation.
//
// Validations :
//   1. Avec `tools: []`, les 115 outils built-in disparaissent
//   2. Avec `settingSources: []`, le SDK ne charge plus les .claude/, CLAUDE.md, skills
//   3. Avec `model: "claude-sonnet-4-6"`, le coût tombe drastiquement
//   4. Avec uniquement nos mcp__nova__* exposés, Claude est forcé de les utiliser
//
// Objectif coût : passer de $0.50-0.70 (test2) à $0.01-0.05 par échange.
//
// Usage :
//   export ANTHROPIC_API_KEY=$(op read "op://Private/Anthropic API Key/credential")
//   node test3-restricted.mjs

import { query, tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

if (!process.env.ANTHROPIC_API_KEY) {
  console.error("ERROR: set ANTHROPIC_API_KEY env var before running.");
  process.exit(1);
}

console.log("─".repeat(60));
console.log(" M1 Test 3 — restricted query (cost + isolation mitigations)");
console.log("─".repeat(60));

// Même fixture que test2
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
let toolsAvailableCount = null;

const q = query({
  prompt,
  options: {
    // MITIGATION 1 — modèle pas cher
    model: "claude-sonnet-4-6",

    // MITIGATION 2 — désactiver TOUS les tools built-in du SDK.
    // Seuls les tools des mcpServers seront exposés.
    tools: [],

    // MITIGATION 3 — SDK isolation : pas de .claude/, CLAUDE.md, skills, rules
    settingSources: [],

    // MITIGATION 4 — nos tools Nova in-process
    mcpServers: {
      nova: novaServer,
    },
  },
});

for await (const msg of q) {
  counts[msg.type] = (counts[msg.type] || 0) + 1;

  switch (msg.type) {
    case "system":
      if (msg.subtype === "init") {
        toolsAvailableCount = msg.tools?.length ?? null;
        console.log(`[system:init] session=${msg.session_id?.slice(0, 8)}… model=${msg.model || "(default)"}`);
        console.log(`[system:init] tools available: ${toolsAvailableCount}`);
        if (toolsAvailableCount != null && toolsAvailableCount <= 5) {
          console.log(`[system:init] tools: ${msg.tools.join(", ")}`);
        }
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
          console.log(`\n[tool_result] ${text?.slice(0, 100) ?? "(empty)"}${text?.length > 100 ? "…" : ""}`);
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
      console.log(`─ Tool calls made: ${toolCalls.length}`);
      for (const tc of toolCalls) {
        console.log(`     - ${tc.name}(${JSON.stringify(tc.input)})`);
      }
      break;
    }
  }
}

console.log("\n─ Event type counts:");
for (const [type, n] of Object.entries(counts).sort()) {
  console.log(`    ${type.padEnd(28)} ${n}`);
}

// Critères de PASS
const usedNovaTools = toolCalls.some((tc) => tc.name.startsWith("mcp__nova__"));
const usedOnlyNovaTools = toolCalls.every((tc) => tc.name.startsWith("mcp__nova__"));

console.log("\n─ Évaluation :");
console.log(`    tools available count       : ${toolsAvailableCount} ${toolsAvailableCount != null && toolsAvailableCount < 10 ? "✓" : "(attendu: <10)"}`);
console.log(`    Claude a utilisé nova_*      : ${usedNovaTools ? "✓ OUI" : "✗ NON"}`);
console.log(`    Aucun tool SDK built-in      : ${usedOnlyNovaTools ? "✓" : "✗"}`);
console.log(`    → Comparer le coût ci-dessus au test2 ($0.6663). Objectif < $0.10.\n`);

process.exit(usedNovaTools && usedOnlyNovaTools ? 0 : 1);
