// Test 1 — basic query() without tools.
//
// Validates :
//   1. The SDK loads correctly in Node 22
//   2. Authentication via ANTHROPIC_API_KEY works
//   3. We can stream events from a simple prompt
//   4. The event taxonomy matches what we expect for a chat UI
//
// Usage :
//   export ANTHROPIC_API_KEY="sk-ant-..."
//   node test1-basic.mjs

import { query } from "@anthropic-ai/claude-agent-sdk";

if (!process.env.ANTHROPIC_API_KEY) {
  console.error("ERROR: set ANTHROPIC_API_KEY env var before running.");
  console.error("Get one at https://console.anthropic.com/settings/keys");
  process.exit(1);
}

console.log("─".repeat(60));
console.log(" M1 Test 1 — basic query, no tools");
console.log(`─ Node: ${process.version}, arch: ${process.arch}`);
console.log("─".repeat(60));

const prompt = "In exactly 3 short sentences, explain what a pseudo-terminal (PTY) is. No code.";

console.log("\n[user]", prompt, "\n");

// Counters for the final summary
const counts = {};
let firstAssistantText = null;
let sessionId = null;

const startedAt = Date.now();

const q = query({
  prompt,
  options: {
    // No tools at all — we want a pure text-streaming validation
    allowedTools: [],
    // Use the default model (lets SDK pick)
  },
});

for await (const msg of q) {
  counts[msg.type] = (counts[msg.type] || 0) + 1;

  // Capture session_id for potential resume tests later
  if (msg.session_id && !sessionId) sessionId = msg.session_id;

  switch (msg.type) {
    case "system":
      if (msg.subtype === "init") {
        console.log(`[system:init] session=${msg.session_id?.slice(0, 8)}… model=${msg.model || "default"}`);
      }
      break;

    case "assistant": {
      const content = msg.message?.content ?? [];
      for (const block of content) {
        if (block.type === "text") {
          process.stdout.write(block.text);
          if (!firstAssistantText) firstAssistantText = block.text;
        } else if (block.type === "tool_use") {
          console.log(`\n[tool_use] ${block.name}(${JSON.stringify(block.input).slice(0, 80)})`);
        } else if (block.type === "thinking") {
          // extended thinking
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
      break;
    }

    case "stream_event":
    case "partial_assistant":
      // These exist but are noisy; we skip
      break;

    default:
      // Catch-all so we see anything unexpected
      // (commented to keep output clean — uncomment for debugging)
      // console.log(`\n[${msg.type}]`, JSON.stringify(msg).slice(0, 120));
      break;
  }
}

console.log("\n─ Event type counts:");
for (const [type, n] of Object.entries(counts).sort()) {
  console.log(`    ${type.padEnd(28)} ${n}`);
}
console.log(`─ Session ID: ${sessionId ?? "(none captured)"}`);
console.log("─ Test 1 PASS\n");
