// ws-auth.mjs — shared authorization for the chat (/ws) and terminal
// (/cli) WebSocket endpoints served by chat-session.mjs.
//
// Threat model: both endpoints bind 127.0.0.1 only, but a WebSocket
// opened from a web page is NOT subject to CORS — any site loaded in a
// browser on this Mac could connect to ws://127.0.0.1:<port>/cli and
// get a PTY running `claude`, or drive the chat in acceptEdits mode.
// DNS rebinding (evil.example resolving to 127.0.0.1) has the same
// effect over plain HTTP.
//
// Defenses, all applied at upgrade time:
//   1. Host header must name this loopback server (blocks DNS rebinding).
//   2. Origin header, when present, must be this server's own origin
//      (blocks cross-site WebSocket hijacking from any other page).
//   3. A per-install secret token must be supplied as ?token=… and is
//      compared in constant time (blocks non-browser local callers that
//      don't know the token, e.g. another user's process).
//
// Pure functions — no I/O — so they are unit-testable without a server.

import { timingSafeEqual } from "crypto";

const LOOPBACK_HOSTS = ["127.0.0.1", "localhost", "[::1]"];

function normalizeHost(value) {
  return String(value || "").trim().toLowerCase();
}

/** Every Host / Origin the server considers "itself" for a given port. */
export function allowedHosts(port) {
  return LOOPBACK_HOSTS.map((h) => `${h}:${port}`);
}

export function allowedOrigins(port) {
  return allowedHosts(port).map((h) => `http://${h}`);
}

function safeEqual(a, b) {
  const ab = Buffer.from(String(a), "utf8");
  const bb = Buffer.from(String(b), "utf8");
  if (ab.length !== bb.length) {
    // Still burn a comparison so length leaks are the only signal.
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

/**
 * Decide whether an incoming HTTP request (plain or upgrade) may proceed.
 *
 * @param {import("http").IncomingMessage} req
 * @param {{ token?: string|null, port: number, requireToken?: boolean }} opts
 *   token        — the shared secret; null/empty disables the token check
 *   port         — the port this server listens on
 *   requireToken — default true for upgrades; pass false for static assets
 * @returns {{ ok: true } | { ok: false, status: number, reason: string }}
 */
export function authorizeRequest(req, { token, port, requireToken = true } = {}) {
  const headers = (req && req.headers) || {};

  // 1. Host — must be one of our own loopback spellings.
  const host = normalizeHost(headers.host);
  if (!allowedHosts(port).includes(host)) {
    return { ok: false, status: 403, reason: `unexpected Host header "${headers.host || ""}"` };
  }

  // 2. Origin — browsers always send it on WebSocket upgrades. Absent is
  //    fine (curl, node clients); present-but-foreign is a hijack attempt.
  if (headers.origin !== undefined) {
    const origin = normalizeHost(headers.origin);
    if (!allowedOrigins(port).includes(origin)) {
      return { ok: false, status: 403, reason: `foreign Origin "${headers.origin}"` };
    }
  }

  // 3. Token — ?token=<secret> in the URL.
  if (requireToken && token) {
    let supplied = null;
    try {
      supplied = new URL(req.url || "/", `http://${host}`).searchParams.get("token");
    } catch (_) { /* malformed URL → treated as missing token */ }
    if (!supplied || !safeEqual(supplied, token)) {
      return { ok: false, status: 401, reason: "missing or invalid token" };
    }
  }

  return { ok: true };
}

/** Write a minimal HTTP error on a raw upgrade socket and close it. */
export function rejectUpgrade(socket, status, reason) {
  const text = status === 401 ? "Unauthorized" : status === 404 ? "Not Found" : "Forbidden";
  try {
    socket.write(
      `HTTP/1.1 ${status} ${text}\r\n` +
      "Connection: close\r\n" +
      "Content-Type: text/plain; charset=utf-8\r\n" +
      `Content-Length: ${Buffer.byteLength(reason || text)}\r\n\r\n` +
      (reason || text),
    );
  } catch (_) { /* socket already gone */ }
  try { socket.destroy(); } catch (_) {}
}
