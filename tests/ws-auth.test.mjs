#!/usr/bin/env node
// Unit tests for Scripts/ws-auth.mjs — the Host / Origin / token gate in
// front of the chat (/ws) and terminal (/cli) WebSocket endpoints.
// Pure functions, no server needed, no dependencies beyond node core.

import assert from "node:assert/strict";
import { authorizeRequest, allowedHosts, allowedOrigins } from "../claudecode-nova.novaextension/Scripts/ws-auth.mjs";

const PORT = 5180;
const TOKEN = "0b1c2d3e-4f50-4617-8899-aabbccddeeff";

function req(url, headers = {}) {
  return { url, headers: { host: `127.0.0.1:${PORT}`, ...headers } };
}

let passed = 0;
function check(name, fn) {
  try { fn(); passed++; }
  catch (err) { console.error(`FAIL: ${name}\n  ${err.message}`); process.exit(1); }
}

check("allowedHosts covers the three loopback spellings", () => {
  assert.deepEqual(allowedHosts(PORT), [`127.0.0.1:${PORT}`, `localhost:${PORT}`, `[::1]:${PORT}`]);
  assert.deepEqual(allowedOrigins(PORT), [`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`, `http://[::1]:${PORT}`]);
});

check("accepts a same-origin upgrade carrying the right token", () => {
  const r = authorizeRequest(req(`/ws?token=${TOKEN}`, { origin: `http://127.0.0.1:${PORT}` }), { token: TOKEN, port: PORT });
  assert.deepEqual(r, { ok: true });
});

check("accepts a non-browser client (no Origin) with the right token", () => {
  const r = authorizeRequest(req(`/cli?session=abc&token=${TOKEN}`), { token: TOKEN, port: PORT });
  assert.deepEqual(r, { ok: true });
});

check("accepts localhost spelling of Host and Origin", () => {
  const r = authorizeRequest(
    { url: `/ws?token=${TOKEN}`, headers: { host: `localhost:${PORT}`, origin: `http://LOCALHOST:${PORT}` } },
    { token: TOKEN, port: PORT },
  );
  assert.deepEqual(r, { ok: true });
});

check("rejects a foreign Origin even with a valid token (cross-site hijack)", () => {
  const r = authorizeRequest(req(`/ws?token=${TOKEN}`, { origin: "https://evil.example" }), { token: TOKEN, port: PORT });
  assert.equal(r.ok, false);
  assert.equal(r.status, 403);
});

check("rejects a foreign Host (DNS rebinding)", () => {
  const r = authorizeRequest({ url: `/ws?token=${TOKEN}`, headers: { host: "evil.example:5180" } }, { token: TOKEN, port: PORT });
  assert.equal(r.ok, false);
  assert.equal(r.status, 403);
});

check("rejects a Host on the wrong port", () => {
  const r = authorizeRequest({ url: `/ws?token=${TOKEN}`, headers: { host: "127.0.0.1:5181" } }, { token: TOKEN, port: PORT });
  assert.equal(r.ok, false);
  assert.equal(r.status, 403);
});

check("rejects a missing token", () => {
  const r = authorizeRequest(req("/ws"), { token: TOKEN, port: PORT });
  assert.equal(r.ok, false);
  assert.equal(r.status, 401);
});

check("rejects a wrong token of the same length", () => {
  const wrong = TOKEN.slice(0, -1) + "0";
  const r = authorizeRequest(req(`/ws?token=${wrong}`), { token: TOKEN, port: PORT });
  assert.equal(r.ok, false);
  assert.equal(r.status, 401);
});

check("rejects a wrong token of a different length", () => {
  const r = authorizeRequest(req("/ws?token=short"), { token: TOKEN, port: PORT });
  assert.equal(r.ok, false);
  assert.equal(r.status, 401);
});

check("static assets can skip the token but still enforce Host/Origin", () => {
  assert.deepEqual(authorizeRequest(req("/chat.js"), { token: TOKEN, port: PORT, requireToken: false }), { ok: true });
  const r = authorizeRequest(req("/chat.js", { origin: "https://evil.example" }), { token: TOKEN, port: PORT, requireToken: false });
  assert.equal(r.ok, false);
});

check("no configured token → token check disabled, Host/Origin still enforced", () => {
  assert.deepEqual(authorizeRequest(req("/ws"), { token: null, port: PORT }), { ok: true });
  assert.equal(authorizeRequest({ url: "/ws", headers: { host: "evil.example:5180" } }, { token: null, port: PORT }).ok, false);
});

console.log(`PASS: ws-auth — ${passed} checks`);
