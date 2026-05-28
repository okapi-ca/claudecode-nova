// Test 2 — query() with an in-process MCP tool (mocked Nova).
//
// This is the pattern we'll use in ws-server.js : Nova editor operations
// (openFile, openDiff, etc.) wrapped as in-process tools that the SDK can
// invoke directly. No external MCP transport needed.
//
// Validates :
//   1. createSdkMcpServer() registers in-process tools correctly
//   2. tool() with a Zod schema validates inputs
//   3. The SDK invokes the handler and streams tool_use + tool_progress events
//   4. The handler can be async (simulates the round-trip to Nova main.js)
//
// Usage :
//   export ANTHROPIC_API_KEY="sk-ant-..."
//   node test2-with-tool.mjs

import { query, tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

if (!process.env.ANTHROPIC_API_KEY) {
  console.error("ERROR: set ANTHROPIC_API_KEY env var before running.");
  process.exit(1);
}

console.log("─".repeat(60));
console.log(" M1 Test 2 — query with in-process tool (mock Nova)");
console.log("─".repeat(60));

// Mock fixture : a fake workspace with two files
const fakeWorkspace = {
  "src/auth.ts": `export function login(user: string, pwd: string) {
  // FIXME: hardcoded admin bypass — security issue
  if (user === "admin") return { ok: true };
  return checkCredentials(user, pwd);
}`,
  "README.md": "# Project\n\nThis is a fake project for the M1 spike.",
};

// In-process tool — this is exactly the shape we'd use to wrap real Nova
// operations via ws-server.js → main.js round-trip.
const novaOpenFile = tool(
  "nova_openFile",
  "Open and read the contents of a file in the Nova editor workspace.",
  {
    path: z.string().describe("Relative path to the file from the workspace root"),
  },
  async (args) => {
    console.log(`\n[tool:nova_openFile] called with path="${args.path}"`);

    // Simulate the async round-trip (ws-server → main.js → editor → back)
    await new Promise((r) => setTimeout(r, 50));

    const content = fakeWorkspace[args.path];
    if (content === undefined) {
      return {
        content: [{ type: "text", text: `Error: file not found: ${args.path}` }],
        isError: true,
      };
    }

    return {
      content: [{ type: "text", text: content }],
    };
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

const q = query({
  prompt,
  options: {
    mcpServers: {
      nova: novaServer,
    },
    // Wildcard auto-approve for our in-process server, deny everything else
    allowedTools: ["mcp__nova__nova_openFile", "mcp__nova__nova_listFiles"],
  },
});

for await (const msg of q) {
  counts[msg.type] = (counts[msg.type] || 0) + 1;

  switch (msg.type) {
    case "system":
      if (msg.subtype === "init") {
        console.log(`[system:init] session=${msg.session_id?.slice(0, 8)}…`);
        if (msg.tools) console.log(`[system:init] tools available: ${msg.tools.length}`);
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
      // Tool results come back as user messages with tool_result content blocks
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

const pass = toolCalls.length >= 1;
console.log(pass ? "─ Test 2 PASS\n" : "─ Test 2 FAIL — no tool calls observed\n");
process.exit(pass ? 0 : 1);
