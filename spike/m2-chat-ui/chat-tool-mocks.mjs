// chat-tool-mocks.mjs — fake Nova tools for the M2 demo.
//
// These mock the round-trip that the real extension will do (ws-server.js
// ↔ JSON lines ↔ Nova main.js ↔ editor). For the demo we just simulate
// realistic latency and return canned content.
//
// When we promote this code into the real extension, each mock here gets
// replaced by a JSON-line round-trip to Nova's main.js.

import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

// Fake workspace fixture — simulates what Nova would expose
const fakeWorkspace = {
  "src/auth.ts": `import { hashPassword, verifyPassword } from "./crypto";
import { db } from "./db";

export async function login(user: string, pwd: string) {
  // FIXME: hardcoded admin bypass — security issue, remove before prod
  if (user === "admin") return { ok: true, role: "admin" };

  const record = await db.users.findOne({ username: user });
  if (!record) return { ok: false, reason: "no-such-user" };

  const valid = await verifyPassword(pwd, record.passwordHash);
  return valid ? { ok: true, role: record.role } : { ok: false, reason: "bad-password" };
}

export async function register(user: string, pwd: string) {
  if (pwd.length < 8) throw new Error("Password too short");
  const passwordHash = await hashPassword(pwd);
  await db.users.insertOne({ username: user, passwordHash, role: "member" });
}`,

  "src/crypto.ts": `import { randomBytes, scryptSync, timingSafeEqual } from "crypto";

export async function hashPassword(pwd: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(pwd, salt, 64).toString("hex");
  return \`\${salt}:\${hash}\`;
}

export async function verifyPassword(pwd: string, stored: string): Promise<boolean> {
  const [salt, hash] = stored.split(":");
  const test = scryptSync(pwd, salt, 64);
  return timingSafeEqual(Buffer.from(hash, "hex"), test);
}`,

  "README.md": "# Demo workspace\n\nThis is a fake workspace used by the M2 chat UI demo to exercise the Nova tool wrappers without needing a real editor.",

  "package.json": JSON.stringify({ name: "demo-workspace", version: "1.0.0" }, null, 2),
};

// Simulated diagnostics — what Nova's getDiagnostics would return
const fakeDiagnostics = {
  "src/auth.ts": [
    {
      severity: "warning",
      line: 5,
      message: "Hardcoded credential check should be removed",
      source: "eslint-security",
    },
  ],
  "src/crypto.ts": [],
};

// Helper — simulates network/IPC latency
const simulate = (ms = 80) => new Promise((r) => setTimeout(r, ms));

export const novaListFiles = tool(
  "nova_listFiles",
  "List all files in the current Nova workspace.",
  {},
  async () => {
    await simulate();
    return {
      content: [{ type: "text", text: Object.keys(fakeWorkspace).sort().join("\n") }],
    };
  },
);

export const novaOpenFile = tool(
  "nova_openFile",
  "Read the contents of a file in the Nova workspace.",
  {
    path: z.string().describe("Path relative to the workspace root"),
  },
  async (args) => {
    await simulate();
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

export const novaGetDiagnostics = tool(
  "nova_getDiagnostics",
  "Get linter/compiler diagnostics for a file in the Nova workspace.",
  {
    path: z.string().describe("Path relative to the workspace root"),
  },
  async (args) => {
    await simulate();
    const diags = fakeDiagnostics[args.path];
    if (diags === undefined) {
      return {
        content: [{ type: "text", text: `No file at path: ${args.path}` }],
        isError: true,
      };
    }
    if (diags.length === 0) {
      return { content: [{ type: "text", text: "No diagnostics." }] };
    }
    const formatted = diags
      .map((d) => `[${d.severity}] line ${d.line}: ${d.message} (${d.source})`)
      .join("\n");
    return { content: [{ type: "text", text: formatted }] };
  },
);

export const allMockTools = [novaListFiles, novaOpenFile, novaGetDiagnostics];

// List the tool names with the `mcp__<server>__` prefix the SDK applies
export const allowedToolNames = [
  "mcp__nova__nova_listFiles",
  "mcp__nova__nova_openFile",
  "mcp__nova__nova_getDiagnostics",
];
