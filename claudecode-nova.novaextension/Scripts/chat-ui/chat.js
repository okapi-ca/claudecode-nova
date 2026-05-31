// chat.js — chat UI client: WebSocket + markdown render + tool cards + copy.
//
// Single-file vanilla JS. No bundler. Uses globals from CDN scripts :
//   - marked (markdown parser)
//   - hljs   (highlight.js)

const $ = (id) => document.getElementById(id);

const chatEl       = $("chat");
const inputEl      = $("input");
const sendBtn      = $("send");
const abortBtn     = $("abort");
const statusDot    = $("status-dot");
const statusText   = $("status-text");
const emptyState   = $("empty-state");
const metaSess     = $("meta-session");
const metaCost     = $("meta-cost");
const metaMode     = $("meta-mode");
const slashMenuEl  = $("slash-menu");
const injectCtxEl  = $("inject-context");
const modelPicker  = $("model-picker");

let ws = null;
let inFlight = false;
let currentAssistantBubble = null;
let currentAssistantBuffer = "";
let toolCardsByName = []; // queue of cards waiting for a matching tool_result
let currentThinkingBody = null;
let currentThinkingBuffer = "";
let currentPendingEl = null; // pre-content "Claude is thinking…" placeholder

// ── cost / token accumulation ─────────────────────────────────────
//
// `last` is whatever the backend just reported (per-message cost).
// `session` accumulates from chat-app boot or /clear.
// `daily` is persisted to localStorage keyed by ISO date — survives
// page reloads, resets at midnight local time.
let sessionCost   = 0;
let sessionInTk   = 0;
let sessionOutTk  = 0;
let currentSessionId = null;  // backend session id; changes reset session counters

// Resolve the daily key fresh every call so a chat window left open
// across midnight starts incrementing the new day's bucket instead of
// continuing to write yesterday's.
function dailyKey() {
  return "claudecode_cost_" + new Date().toISOString().slice(0, 10);
}

function loadDailyCost() {
  try {
    const raw = localStorage.getItem(dailyKey());
    if (!raw) return { cost: 0, inTk: 0, outTk: 0 };
    return JSON.parse(raw);
  } catch (e) {
    return { cost: 0, inTk: 0, outTk: 0 };
  }
}

function saveDailyCost(daily) {
  try { localStorage.setItem(dailyKey(), JSON.stringify(daily)); }
  catch (e) { /* localStorage full or unavailable — silent */ }
}

function accumulateCost(cost, tokens) {
  if (typeof cost === "number") {
    sessionCost += cost;
    const d = loadDailyCost();
    d.cost = (d.cost || 0) + cost;
    if (tokens && typeof tokens.input === "number")  { sessionInTk  += tokens.input;  d.inTk  = (d.inTk  || 0) + tokens.input; }
    if (tokens && typeof tokens.output === "number") { sessionOutTk += tokens.output; d.outTk = (d.outTk || 0) + tokens.output; }
    saveDailyCost(d);
  }
  renderCostMeta(cost, tokens);
}

function formatTokens(n) {
  if (n == null) return "?";
  if (n < 1000) return String(n);
  if (n < 10000) return (n / 1000).toFixed(1) + "k";
  return Math.round(n / 1000) + "k";
}

function renderCostMeta(lastCost, lastTokens) {
  const d = loadDailyCost();
  const parts = [];
  if (typeof lastCost === "number") {
    parts.push(`last $${lastCost.toFixed(4)}`);
  }
  if (sessionCost > 0) parts.push(`session $${sessionCost.toFixed(4)}`);
  if (d.cost > 0)      parts.push(`today $${d.cost.toFixed(4)}`);
  // Tokens in clear (not just a tooltip) — last turn's in/out.
  if (lastTokens && (lastTokens.input != null || lastTokens.output != null)) {
    parts.push(`${formatTokens(lastTokens.input)} in / ${formatTokens(lastTokens.output)} out`);
  }
  metaCost.textContent = parts.join(" · ");
  // Tooltip keeps the cumulative session/today token breakdown.
  const tooltip = [
    sessionInTk + sessionOutTk > 0 ? `Session: ${formatTokens(sessionInTk)} in / ${formatTokens(sessionOutTk)} out` : null,
    (d.inTk || 0) + (d.outTk || 0) > 0 ? `Today: ${formatTokens(d.inTk)} in / ${formatTokens(d.outTk)} out` : null,
  ].filter(Boolean).join("\n");
  metaCost.title = tooltip || "Cost & tokens (last turn shown inline)";
}

// Context-window gauge. The latest turn's input_tokens approximates how
// full the context is (system + history + new prompt sent that turn).
// Max depends on the model: the Opus 4.8 "1M" variant gets 1,000,000,
// everything else 200,000.
function contextMaxForModel(model) {
  return /opus-4-8/.test(model || "") ? 1000000 : 200000;
}

function renderContextGauge(inputTokens) {
  const el = document.getElementById("meta-ctx");
  if (!el || typeof inputTokens !== "number") return;
  const max = contextMaxForModel(chatStatus.model || (modelPicker && modelPicker.value));
  const pct = Math.min(100, Math.round((inputTokens / max) * 100));
  el.textContent = `ctx ${formatTokens(inputTokens)}/${formatTokens(max)} (${pct}%)`;
  el.title = `Context window used last turn`;
  // Warn-tint as the window fills up.
  el.className = "meta-ctx" + (pct >= 85 ? " meta-ctx--high" : pct >= 60 ? " meta-ctx--mid" : "");
}

function resetSessionCost() {
  sessionCost = 0;
  sessionInTk = 0;
  sessionOutTk = 0;
  renderCostMeta(null, null);
}

// ── multimodal: image attachments ────────────────────────────────
//
// Anthropic accepts PNG / JPEG / GIF / WebP up to ~5 MB each. We hold
// pending images in `pendingAttachments` until the next user_message
// sends them, then clear. Images can come from three sources :
//   - drag-and-drop onto the input wrap
//   - Cmd+V paste (clipboard event with `kind: "file"`)
//   - (future) file picker button — not wired yet, keeping the surface small
const SUPPORTED_IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // Anthropic API hard limit
let pendingAttachments = [];

function isMultimodalAllowed() {
  // CLI mode doesn't support images. SDK is the gate.
  return chatStatus && chatStatus.mode === "sdk";
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result; // "data:image/png;base64,xxx"
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error || new Error("read failed"));
    reader.readAsDataURL(file);
  });
}

async function addAttachmentFromFile(file) {
  if (!file || !SUPPORTED_IMAGE_TYPES.includes(file.type)) return;
  const tooLarge = file.size > MAX_IMAGE_BYTES;
  const dataUrl = URL.createObjectURL(file);
  let data = null;
  try {
    data = await fileToBase64(file);
  } catch (err) {
    console.warn("attachment encode failed:", err);
    return;
  }
  pendingAttachments.push({
    id: "att-" + Date.now() + "-" + Math.random().toString(36).slice(2, 7),
    name: file.name || "image",
    mediaType: file.type,
    bytes: file.size,
    data, // base64 (no data: prefix)
    dataUrl, // for thumbnail rendering
    tooLarge,
  });
  renderAttachments();
}

function removeAttachment(id) {
  const i = pendingAttachments.findIndex((a) => a.id === id);
  if (i < 0) return;
  const a = pendingAttachments[i];
  if (a.dataUrl) URL.revokeObjectURL(a.dataUrl);
  pendingAttachments.splice(i, 1);
  renderAttachments();
}

function clearAttachments() {
  for (const a of pendingAttachments) {
    if (a.dataUrl) URL.revokeObjectURL(a.dataUrl);
  }
  pendingAttachments = [];
  renderAttachments();
}

function renderAttachments() {
  const wrap = $("attachments");
  if (!wrap) return;
  if (pendingAttachments.length === 0) {
    wrap.hidden = true;
    wrap.innerHTML = "";
    return;
  }
  wrap.hidden = false;
  wrap.innerHTML = pendingAttachments
    .map((a) => `
      <div class="attachment" data-id="${a.id}" title="${escapeHtml(a.name)} · ${Math.round(a.bytes / 1024)} KB">
        <img src="${a.dataUrl}" alt="${escapeHtml(a.name)}">
        ${a.tooLarge ? `<div class="attachment__too-large">> 5 MB — skipped</div>` : ""}
        <button class="attachment__remove" data-remove="${a.id}" title="Remove">×</button>
      </div>
    `)
    .join("");
  wrap.querySelectorAll("[data-remove]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      removeAttachment(btn.getAttribute("data-remove"));
    });
  });
}

// Slash commands available from the composer. The `cmd` value is sent
// to the backend, which maps it to a templated prompt. The `desc` is
// only used for the menu label.
const SLASH_COMMANDS = [
  { cmd: "explain",  label: "/explain",  desc: "Explain the selected code" },
  { cmd: "refactor", label: "/refactor", desc: "Refactor for clarity" },
  { cmd: "review",   label: "/review",   desc: "Review for style + bugs + security" },
  { cmd: "optimize", label: "/optimize", desc: "Suggest perf / memory improvements" },
  { cmd: "simplify", label: "/simplify", desc: "Reduce complexity (extract / flatten)" },
  { cmd: "types",    label: "/types",    desc: "Add idiomatic type annotations" },
  { cmd: "security", label: "/security", desc: "Focused OWASP-style security review" },
  { cmd: "rename",   label: "/rename",   desc: "Suggest clearer identifier names" },
  { cmd: "test",     label: "/test",     desc: "Write tests" },
  { cmd: "doc",      label: "/doc",      desc: "Add inline documentation" },
  { cmd: "fix",      label: "/fix",      desc: "Find and fix bugs" },
  { cmd: "commit",       label: "/commit",       desc: "Draft a commit message from current diff" },
  { cmd: "changelog",    label: "/changelog",    desc: "Generate next CHANGELOG entry from commits" },
  { cmd: "pr",           label: "/pr",           desc: "Draft a PR description (summary + changes + test plan)" },
  { cmd: "explain-error",label: "/explain-error",desc: "Diagnose a stack trace or error message" },
  { cmd: "why",          label: "/why",          desc: "Explain WHY the selected code exists (intent / constraints)" },
  { cmd: "search",       label: "/search",       desc: "Recursive grep across the workspace" },
  { cmd: "find",         label: "/find",         desc: "Locate a symbol definition" },
  { cmd: "plan",         label: "/plan",         desc: "Plan steps before acting; wait for OK" },
  { cmd: "recap",        label: "/recap",        desc: "Summarize the current conversation" },
  { cmd: "clear",        label: "/clear",        desc: "Wipe the chat and start a fresh session" },
  { cmd: "spec",         label: "/spec",         desc: "Turn the conversation into a formal spec" },
  { cmd: "readme",       label: "/readme",       desc: "Generate (or rewrite) a project README" },
  { cmd: "api-doc",      label: "/api-doc",      desc: "API reference for the selected exports" },
];

// When the user picks a slash command, we send it as a flag and clear
// the input. Setting this here so the next send() picks it up.
let pendingSlashCommand = null;
let slashMenuVisible = false;
let lastSentText = ""; // last prompt sent — recalled by ArrowUp on empty input
let slashMenuActive = 0;

// ── markdown render setup ─────────────────────────────────────────

function setupMarked() {
  if (typeof marked === "undefined") {
    console.warn("marked not yet loaded — retrying");
    return false;
  }
  marked.setOptions({
    breaks: true,
    gfm: true,
  });
  return true;
}

function renderMarkdown(text) {
  if (typeof marked === "undefined") return escapeHtml(text);
  return marked.parse(text);
}

function escapeHtml(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function highlightCodeBlocks(rootEl) {
  if (typeof hljs === "undefined") return;
  rootEl.querySelectorAll("pre code").forEach((block) => {
    if (block.dataset.highlighted) return;
    hljs.highlightElement(block);
    block.dataset.highlighted = "true";
    const preEl = block.parentElement;
    addLanguageLabel(preEl, block);
    addCopyButton(preEl);
  });
}

// Extract the syntax label from the highlight.js classes hljs leaves on the
// <code> element. After highlightElement, the language is in a class like
// "language-typescript" or as a bare "typescript" token next to "hljs".
function addLanguageLabel(preEl, codeEl) {
  if (preEl.querySelector(".code-lang")) return;
  let lang = null;
  for (const cls of codeEl.classList) {
    if (cls === "hljs") continue;
    if (cls.startsWith("language-")) { lang = cls.slice(9); break; }
    if (!cls.includes("-")) { lang = cls; break; }
  }
  if (!lang || lang === "plaintext" || lang === "undefined") return;
  const label = document.createElement("span");
  label.className = "code-lang";
  label.textContent = lang;
  preEl.appendChild(label);
}

function addCopyButton(preEl) {
  if (preEl.querySelector(".code-copy")) return;
  const btn = document.createElement("button");
  btn.className = "code-copy";
  btn.textContent = "Copy";
  btn.addEventListener("click", async (e) => {
    e.stopPropagation();
    const code = preEl.querySelector("code");
    try {
      await navigator.clipboard.writeText(code.innerText);
      btn.textContent = "Copied!";
      btn.classList.add("copied");
      setTimeout(() => {
        btn.textContent = "Copy";
        btn.classList.remove("copied");
      }, 1500);
    } catch (err) {
      btn.textContent = "Error";
    }
  });
  preEl.appendChild(btn);
}

// Adds a hover-revealed action row to a message wrapper. Reads text fresh
// from the body so streaming assistant messages copy their current state.
function addMessageActions(wrap) {
  if (wrap.querySelector(".msg__actions")) return;
  const actions = document.createElement("div");
  actions.className = "msg__actions";
  actions.innerHTML = `<button class="msg__action" title="Copy message">Copy</button>`;
  const btn = actions.querySelector(".msg__action");
  btn.addEventListener("click", async (e) => {
    e.stopPropagation();
    const body = wrap.querySelector(".msg__body");
    const txt = body ? body.innerText : "";
    try {
      await navigator.clipboard.writeText(txt);
      btn.textContent = "Copied!";
      btn.classList.add("copied");
      setTimeout(() => { btn.textContent = "Copy"; btn.classList.remove("copied"); }, 1500);
    } catch (err) {
      btn.textContent = "Error";
    }
  });
  wrap.appendChild(actions);
}

// ── DOM helpers for message bubbles ───────────────────────────────

function hideEmptyState() {
  if (emptyState) emptyState.style.display = "none";
}

function appendUserMessage(text) {
  hideEmptyState();
  const wrap = document.createElement("div");
  wrap.className = "msg msg--user";
  wrap.innerHTML = `
    <div class="msg__role">You</div>
    <div class="msg__body"></div>
  `;
  wrap.querySelector(".msg__body").textContent = text;
  chatEl.appendChild(wrap);
  addMessageActions(wrap);
  scrollToBottom(true); // sending a message always jumps to the bottom
}

function ensureAssistantBubble() {
  if (currentAssistantBubble) return currentAssistantBubble;
  hideEmptyState();
  const wrap = document.createElement("div");
  wrap.className = "msg msg--assistant";
  wrap.innerHTML = `
    <div class="msg__role">Claude</div>
    <div class="msg__body"></div>
  `;
  chatEl.appendChild(wrap);
  currentAssistantBubble = wrap.querySelector(".msg__body");
  currentAssistantBuffer = "";
  addMessageActions(wrap);
  return currentAssistantBubble;
}

function appendAssistantText(chunk) {
  removePendingPlaceholder();
  // Any text means thinking is over — collapse it so the actual response
  // isn't visually crowded.
  if (currentThinkingBody) collapseCurrentThinking();
  // First text chunk after a tool / init transitions the status bar
  // so the user sees Claude is now generating the reply rather than
  // sitting on an opaque "working…" state.
  if (!currentAssistantBubble) {
    setStatus("thinking", "Writing response…");
  }
  const body = ensureAssistantBubble();
  currentAssistantBuffer += chunk;
  body.innerHTML = renderMarkdown(currentAssistantBuffer);
  highlightCodeBlocks(body);
  scrollToBottom();
}

// ── thinking block (collapsible "💭 Reasoning…") ──────────────────

function ensureThinkingBlock() {
  if (currentThinkingBody) return currentThinkingBody;
  removePendingPlaceholder();
  hideEmptyState();
  // Reset any text bubble so the thinking is visually distinct
  currentAssistantBubble = null;
  currentAssistantBuffer = "";

  const wrap = document.createElement("div");
  wrap.className = "thinking expanded";
  wrap.innerHTML = `
    <div class="thinking__header" role="button" title="Claude's internal reasoning — click to collapse">
      <span class="thinking__spinner"></span>
      <span class="thinking__icon">💭</span>
      <span class="thinking__label">Reasoning…</span>
      <span class="thinking__caret">▼</span>
    </div>
    <div class="thinking__body"></div>
  `;
  wrap.querySelector(".thinking__header").addEventListener("click", () => {
    wrap.classList.toggle("expanded");
    const caret = wrap.querySelector(".thinking__caret");
    if (caret) caret.textContent = wrap.classList.contains("expanded") ? "▼" : "▶";
  });
  chatEl.appendChild(wrap);
  currentThinkingBody = wrap.querySelector(".thinking__body");
  currentThinkingBuffer = "";
  setStatus("thinking", "Thinking aloud…");
  return currentThinkingBody;
}

function appendThinking(chunk) {
  const body = ensureThinkingBlock();
  currentThinkingBuffer += chunk;
  // Plain text, line-broken — no markdown rendering for raw thoughts
  body.textContent = currentThinkingBuffer;
  scrollToBottom();
}

function collapseCurrentThinking() {
  if (!currentThinkingBody) return;
  const wrap = currentThinkingBody.closest(".thinking");
  if (wrap) {
    wrap.classList.remove("expanded");
    wrap.classList.add("done");
    const label = wrap.querySelector(".thinking__label");
    if (label) label.textContent = "Reasoning";
    const caret = wrap.querySelector(".thinking__caret");
    if (caret) caret.textContent = "▶";
  }
  currentThinkingBody = null;
  currentThinkingBuffer = "";
}

// ── pre-content placeholder (visible while waiting for first delta) ─

function showPendingPlaceholder() {
  if (currentPendingEl) return;
  hideEmptyState();
  const el = document.createElement("div");
  el.className = "pending";
  el.innerHTML = `
    <span class="pending__dot"></span>
    <span class="pending__dot"></span>
    <span class="pending__dot"></span>
    <span class="pending__label">Claude is thinking…</span>
  `;
  chatEl.appendChild(el);
  currentPendingEl = el;
  scrollToBottom();
}

function removePendingPlaceholder() {
  if (!currentPendingEl) return;
  currentPendingEl.remove();
  currentPendingEl = null;
}

function appendToolCard(name, input) {
  hideEmptyState();
  // Close any open assistant bubble so the next assistant_text starts a new one
  currentAssistantBubble = null;
  currentAssistantBuffer = "";

  const card = document.createElement("div");
  card.className = "tool tool--running"; // 'running' state until tool_result arrives
  const summary = Object.keys(input).length
    ? JSON.stringify(input)
    : "(no args)";
  const pretty = prettyToolName(name);
  card.innerHTML = `
    <div class="tool__header" role="button">
      <span class="tool__spinner" aria-label="running" title="Tool is running"></span>
      <span class="tool__name">${escapeHtml(pretty)}</span>
      <span class="tool__summary">${escapeHtml(summary)}</span>
      <span class="tool__caret">▶</span>
    </div>
    <div class="tool__details">
      <div class="tool__section-label">Input</div>
      <pre class="tool__pre">${escapeHtml(JSON.stringify(input, null, 2))}</pre>
      <div class="tool__section-label tool__result-label" hidden>Result</div>
      <pre class="tool__pre tool__result" hidden></pre>
    </div>
  `;

  // Status reflects the active tool
  setStatus("thinking", "Using " + pretty + "…");
  card.querySelector(".tool__header").addEventListener("click", () => {
    card.classList.toggle("expanded");
  });
  chatEl.appendChild(card);
  toolCardsByName.push({ name, card });
  scrollToBottom();
}

function attachToolResult(name, text, isError) {
  // Find the first card matching this name (FIFO matching)
  const idx = toolCardsByName.findIndex((c) => c.name === name);
  const target = idx >= 0 ? toolCardsByName.splice(idx, 1)[0].card : null;
  if (!target) return;

  // Stop the spinner / running state — result is in.
  target.classList.remove("tool--running");
  if (isError) target.classList.add("error");

  const label = target.querySelector(".tool__result-label");
  const pre   = target.querySelector(".tool__result");
  label.hidden = false;
  pre.hidden = false;
  pre.textContent = text;

  // Briefly reflect the post-tool processing step in the status bar.
  // Will be overwritten by the next assistant_text or result event.
  setStatus("thinking", "Processing result…");
}

function prettyToolName(name) {
  // "mcp__nova__nova_openFile" → "nova_openFile"
  return name.replace(/^mcp__[^_]+__/, "");
}

// Historical tool cards mirror the live appendToolCard layout but
// arrive collapsed and dimmed so the replay stays scannable. Match
// by tool name (FIFO) when the corresponding result event lands.
const historyToolCards = [];

function appendHistoryToolUse(name, input) {
  hideEmptyState();
  const card = document.createElement("div");
  card.className = "tool tool--history";
  const summary = Object.keys(input || {}).length ? JSON.stringify(input) : "(no args)";
  const pretty = prettyToolName(name);
  card.innerHTML = `
    <div class="tool__header" role="button">
      <span class="tool__icon"></span>
      <span class="tool__name">${escapeHtml(pretty)}</span>
      <span class="tool__summary">${escapeHtml(summary)}</span>
      <span class="tool__caret">▶</span>
    </div>
    <div class="tool__details">
      <div class="tool__section-label">Input</div>
      <pre class="tool__pre">${escapeHtml(JSON.stringify(input || {}, null, 2))}</pre>
      <div class="tool__section-label tool__result-label" hidden>Result</div>
      <pre class="tool__pre tool__result" hidden></pre>
    </div>
  `;
  card.querySelector(".tool__header").addEventListener("click", () => card.classList.toggle("expanded"));
  chatEl.appendChild(card);
  historyToolCards.push({ name, card });
  scrollToBottom();
}

function attachHistoryToolResult(name, text, isError) {
  const idx = historyToolCards.findIndex((c) => c.name === name);
  const target = idx >= 0 ? historyToolCards.splice(idx, 1)[0].card : null;
  if (!target) return;
  if (isError) target.classList.add("error");
  const label = target.querySelector(".tool__result-label");
  const pre   = target.querySelector(".tool__result");
  if (label) label.hidden = false;
  if (pre)   { pre.hidden = false; pre.textContent = text; }
}

// Render a historical (replayed) message — same shape as live bubbles
// but with a `--history` modifier class for dimmed styling so the
// user can tell what was already said vs. what's fresh this turn.
function appendHistoryMessage(role, text) {
  hideEmptyState();
  const wrap = document.createElement("div");
  const isUser = role === "user";
  wrap.className = "msg msg--" + (isUser ? "user" : "assistant") + " msg--history";
  wrap.innerHTML = `
    <div class="msg__role">${isUser ? "You" : "Claude"}</div>
    <div class="msg__body"></div>
  `;
  const body = wrap.querySelector(".msg__body");
  if (isUser) {
    body.textContent = text; // user messages are plain text
  } else {
    body.innerHTML = renderMarkdown(text);
    highlightCodeBlocks(body);
  }
  chatEl.appendChild(wrap);
  addMessageActions(wrap);
  scrollToBottom();
}

function appendErrorMessage(text) {
  const el = document.createElement("div");
  el.className = "error-msg";
  el.textContent = "Error: " + text;
  chatEl.appendChild(el);
  scrollToBottom();
}

// Auto-scroll that respects manual scroll-up. While the user is pinned
// to the bottom, new content scrolls into view; once they scroll up,
// streaming no longer yanks them down — a floating "↓ Latest" button
// appears instead. Pass force=true (e.g. when the user sends a message)
// to always jump down and re-pin.
let pinnedToBottom = true;
const jumpLatestBtn = document.getElementById("jump-latest");

function isNearBottom() {
  return chatEl.scrollHeight - chatEl.scrollTop - chatEl.clientHeight < 48;
}

function scrollToBottom(force) {
  if (force) pinnedToBottom = true;
  if (!pinnedToBottom) {
    if (jumpLatestBtn) jumpLatestBtn.hidden = false;
    return;
  }
  chatEl.scrollTop = chatEl.scrollHeight;
  if (jumpLatestBtn) jumpLatestBtn.hidden = true;
}

chatEl.addEventListener("scroll", () => {
  pinnedToBottom = isNearBottom();
  if (jumpLatestBtn && pinnedToBottom) jumpLatestBtn.hidden = true;
});

if (jumpLatestBtn) {
  jumpLatestBtn.addEventListener("click", () => {
    pinnedToBottom = true;
    chatEl.scrollTop = chatEl.scrollHeight;
    jumpLatestBtn.hidden = true;
  });
}

// ── WebSocket ─────────────────────────────────────────────────────

function connect() {
  const wsUrl = `ws://${location.host}/ws`;
  ws = new WebSocket(wsUrl);
  setStatus("idle", "Connecting…");

  ws.addEventListener("open", () => {
    setStatus("connected", "Ready");
  });

  ws.addEventListener("close", () => {
    setStatus("error", "Disconnected — reconnecting…");
    setTimeout(connect, 1500);
  });

  ws.addEventListener("error", () => {
    setStatus("error", "WebSocket error");
  });

  ws.addEventListener("message", (event) => {
    let msg;
    try { msg = JSON.parse(event.data); }
    catch { return; }
    handleServerMessage(msg);
  });
}

function handleServerMessage(msg) {
  switch (msg.type) {
    case "sessions":
      if (pendingSessionsFor === "cli") showTermResumeMenu(msg.sessions || []);
      else showResumeMenu(msg.sessions || []);
      pendingSessionsFor = null;
      break;

    case "live_sessions":
      showLiveSessionsMenu(msg.sessions || []);
      break;

    case "resume_external":
      // The Nova sidebar's action panel told us to resume this
      // session. Reuse the same in-chat resume flow (which triggers
      // history replay + sets currentSessionId server-side).
      if (msg.sessionId) pickResumeSession(msg.sessionId, "");
      // Bring this panel to the visible layout if the user was in
      // CLI-only mode — otherwise the resume is invisible to them.
      if (panelsEl && chatPanel.hidden) setLayout("chat");
      break;

    case "history_begin":
      // Wipe the empty-state and any leftover content so the replay
      // starts from a clean transcript.
      hideEmptyState();
      // Note in the transcript that we're about to load past turns.
      {
        const hdr = document.createElement("div");
        hdr.className = "history-marker";
        hdr.textContent = `↻ Loading session ${(msg.sessionId || "").slice(0, 8)}… (history below)`;
        chatEl.appendChild(hdr);
      }
      break;

    case "history_message":
      appendHistoryMessage(msg.role, msg.text);
      break;

    case "history_tool_use":
      appendHistoryToolUse(msg.name, msg.input || {});
      break;

    case "history_tool_result":
      attachHistoryToolResult(msg.name, msg.text || "", msg.isError);
      break;

    case "history_end":
      {
        const mk = document.createElement("div");
        mk.className = "history-marker history-marker--end";
        mk.textContent = "— end of replay · continue below —";
        chatEl.appendChild(mk);
        scrollToBottom();
      }
      break;

    case "session_resumed":
      // Backend confirmed the resume; nothing to render — the next
      // user_message will carry --resume / resume:.
      break;

    case "session_cleared":
      // Backend confirmed /clear; nothing to add — the marker is
      // already in place from runClearCommand().
      break;

    case "bridge_status": {
      const dot = document.getElementById("bridge-dot");
      const txt = document.getElementById("bridge-text");
      if (dot && txt) {
        const n = msg.clientCount || 0;
        if (msg.port) {
          // The bridge is up the moment it has a port — clients are
          // additional information, not a prerequisite. Green when
          // listening; idle only when the bridge isn't started yet.
          txt.textContent = `Bridge: port ${msg.port} · ${n} client${n === 1 ? "" : "s"}`;
          dot.className = "dot dot--connected";
        } else {
          txt.textContent = "Bridge: starting…";
          dot.className = "dot dot--idle";
        }
      }
      break;
    }

    case "config":
      // Sent once right after the WS connection opens. Pre-populates
      // the model picker, mode badge, and theme override so they
      // reflect the backend's actual default before any session_started
      // event arrives.
      if (msg.defaultModel && modelPicker) {
        modelPicker.value = stripModelSuffix(msg.defaultModel);
      }
      applyModeBadge(msg.mode);
      applyTheme(msg.theme);
      if (msg.mode) chatStatus.mode = msg.mode;
      if (msg.defaultModel) chatStatus.model = stripModelSuffix(msg.defaultModel);
      renderChatStatus();
      break;

    case "session_started":
      metaSess.textContent = `session ${msg.sessionId.slice(0, 8)}…`;
      // Reset session cost when the backend starts a fresh session
      // (different ID than what we last saw). Resume/replay keep the
      // same ID and therefore the same running totals.
      if (currentSessionId && currentSessionId !== msg.sessionId) {
        resetSessionCost();
      }
      currentSessionId = msg.sessionId;
      applyModeBadge(msg.mode);
      // Sync the picker to the model the backend actually started with —
      // it may differ from the picker's default if the user configured
      // something else in extension settings. Don't fire `change`.
      if (msg.model && modelPicker) {
        modelPicker.value = stripModelSuffix(msg.model);
      }
      // Apply the user's persisted model choice over the backend default.
      {
        const savedModel = uiPrefGet("model");
        if (savedModel && modelPicker && savedModel !== modelPicker.value) {
          modelPicker.value = savedModel;
          if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "set_model", model: savedModel }));
          }
          chatStatus.model = savedModel;
        }
      }
      if (msg.mode) chatStatus.mode = msg.mode;
      if (msg.model) chatStatus.model = stripModelSuffix(msg.model);
      renderChatStatus();
      setStatus("thinking", "Thinking…");
      break;

    case "assistant_text":
      appendAssistantText(msg.chunk);
      break;

    case "assistant_thinking":
      removePendingPlaceholder();
      appendThinking(msg.chunk);
      break;

    case "assistant_tool_use":
      removePendingPlaceholder();
      if (currentThinkingBody) collapseCurrentThinking();
      appendToolCard(msg.name, msg.input);
      break;

    case "tool_result":
      attachToolResult(msg.name, msg.text, msg.isError);
      break;

    case "result":
      setStatus("connected", "Ready");
      inFlight = false;
      abortBtn.hidden = true;
      sendBtn.disabled = false;
      currentAssistantBubble = null;
      currentAssistantBuffer = "";
      removePendingPlaceholder();
      if (currentThinkingBody) collapseCurrentThinking();
      if (msg.success && msg.cost != null) {
        accumulateCost(msg.cost, msg.tokens);
      } else if (!msg.success) {
        appendErrorMessage(msg.error || "query failed");
      }
      if (msg.tokens && typeof msg.tokens.input === "number") {
        renderContextGauge(msg.tokens.input);
      }
      break;

    case "error":
      appendErrorMessage(msg.message);
      setStatus("connected", "Ready");
      inFlight = false;
      abortBtn.hidden = true;
      sendBtn.disabled = false;
      removePendingPlaceholder();
      if (currentThinkingBody) collapseCurrentThinking();
      break;
  }
}

function setStatus(kind, text) {
  statusDot.className = "dot dot--" + kind;
  statusText.textContent = text;
  // Mirror to the composer-side status indicator so the user sees
  // Claude's current activity near the input field, not just in the
  // far-away topbar.
  const cd = document.getElementById("composer-status-dot");
  const ct = document.getElementById("composer-status-text");
  if (cd) cd.className = "dot dot--" + kind;
  if (ct) ct.textContent = text;
}

// ── send flow ─────────────────────────────────────────────────────

function sendUserMessage() {
  const text = inputEl.value.trim();
  // A slash command, attachment-only, or any text is enough to send.
  const hasAttachments = pendingAttachments.some((a) => !a.tooLarge);
  if ((!text && !pendingSlashCommand && !hasAttachments) || inFlight || !ws || ws.readyState !== WebSocket.OPEN) return;
  inFlight = true;

  const injectContext = !!(injectCtxEl && injectCtxEl.checked);
  const slashCommand  = pendingSlashCommand;

  // Visual representation: prepend the slash label so the user sees
  // which command was used in the transcript.
  const attachmentsLabel = hasAttachments
    ? ` [${pendingAttachments.filter((a) => !a.tooLarge).length} image${pendingAttachments.length > 1 ? "s" : ""}]`
    : "";
  const displayText = (slashCommand
    ? `/${slashCommand}${text ? " " + text : ""}`
    : (text || "(image only)")) + attachmentsLabel;
  appendUserMessage(displayText);
  if (text) lastSentText = text; // for ArrowUp edit/resend recall

  // Build the attachments payload — drop too-large ones, strip dataUrl
  // (frontend-only) but keep base64 data + mediaType for the backend.
  const attachments = pendingAttachments
    .filter((a) => !a.tooLarge)
    .map((a) => ({ data: a.data, mediaType: a.mediaType, name: a.name }));

  ws.send(JSON.stringify({
    type: "user_message",
    text,
    slashCommand,
    injectContext,
    ...(attachments.length > 0 ? { attachments } : {}),
  }));

  inputEl.value = "";
  pendingSlashCommand = null;
  hideSlashMenu();
  clearAttachments();
  sendBtn.disabled = true;
  abortBtn.hidden = false;
  setStatus("thinking", "Sending…");

  // Show a pulsing placeholder until the first content delta arrives.
  // The CLI's first delta can take 2-5s on cold context; without this
  // the chat appears frozen.
  showPendingPlaceholder();
}

// ── slash-command menu ────────────────────────────────────────────

function showSlashMenu(filter) {
  const matches = SLASH_COMMANDS.filter((c) =>
    !filter || c.cmd.startsWith(filter.toLowerCase())
  );
  if (matches.length === 0) { hideSlashMenu(); return; }

  slashMenuEl.innerHTML = matches.map((c, i) => `
    <button class="slash-menu__item${i === 0 ? " active" : ""}" data-cmd="${c.cmd}">
      <span class="slash-menu__label">${c.label}</span>
      <span class="slash-menu__desc">${c.desc}</span>
    </button>
  `).join("");
  slashMenuEl.hidden = false;
  slashMenuVisible = true;
  slashMenuActive = 0;

  slashMenuEl.querySelectorAll(".slash-menu__item").forEach((el) => {
    el.addEventListener("mousedown", (e) => {
      e.preventDefault();
      pickSlashCommand(el.dataset.cmd);
    });
  });
}

function hideSlashMenu() {
  slashMenuEl.hidden = true;
  slashMenuVisible = false;
}

function moveSlashMenuActive(delta) {
  const items = slashMenuEl.querySelectorAll(".slash-menu__item");
  if (!items.length) return;
  items[slashMenuActive]?.classList.remove("active");
  slashMenuActive = (slashMenuActive + delta + items.length) % items.length;
  items[slashMenuActive].classList.add("active");
}

function pickActiveSlashCommand() {
  const item = slashMenuEl.querySelectorAll(".slash-menu__item")[slashMenuActive];
  if (item) pickSlashCommand(item.dataset.cmd);
}

function pickSlashCommand(cmd) {
  // /clear is a frontend-only action — wipe the transcript and tell
  // the backend to drop currentSessionId. We don't send anything to
  // the LLM.
  if (cmd === "clear") {
    runClearCommand();
    hideSlashMenu();
    return;
  }
  pendingSlashCommand = cmd;
  // Clear the "/foo" the user typed and let them add extra context if they want
  inputEl.value = "";
  inputEl.placeholder = `/${cmd} — add any extra context, then press Enter (or Enter again to send as-is)`;
  hideSlashMenu();
  inputEl.focus();
}

// Local wipe — does NOT call the LLM. Clears the chat history DOM
// and tells chat-session.mjs to forget currentSessionId so the next
// user_message starts a brand-new conversation.
function runClearCommand() {
  // Drop every message bubble, tool card, thinking block, marker.
  while (chatEl.firstChild) chatEl.removeChild(chatEl.firstChild);
  currentAssistantBubble = null;
  currentAssistantBuffer = "";
  currentThinkingBody = null;
  currentThinkingBuffer = "";
  if (currentPendingEl) { currentPendingEl.remove(); currentPendingEl = null; }
  toolCardsByName.length = 0;
  historyToolCards.length = 0;
  // Reset the meta bar info that ties to a specific session.
  if (metaSess) metaSess.textContent = "";
  currentSessionId = null;
  resetSessionCost();

  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "reset_session" }));
  }

  const marker = document.createElement("div");
  marker.className = "history-marker";
  marker.textContent = "↻ Session cleared — next message starts fresh";
  chatEl.appendChild(marker);
  setStatus("connected", "Ready");
  inputEl.placeholder = "Ask Claude… (type / for slash commands · Enter to send · Shift+Enter for newline)";
}

function onInputChange() {
  const val = inputEl.value;
  if (val.startsWith("/") && !pendingSlashCommand) {
    // Show menu, filter on what they've typed after "/"
    const filter = val.slice(1);
    if (filter.includes(" ") || filter.includes("\n")) {
      hideSlashMenu(); // they moved on past the command name
    } else {
      showSlashMenu(filter);
    }
  } else if (slashMenuVisible) {
    hideSlashMenu();
  }

  // Reset placeholder when they clear after a slash command was active
  if (!val && !pendingSlashCommand) {
    inputEl.placeholder = "Ask Claude… (type / for slash commands · Enter to send · Shift+Enter for newline)";
  }
}

function abortQuery() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: "abort" }));
}

// ── input wiring ──────────────────────────────────────────────────

sendBtn.addEventListener("click", sendUserMessage);
abortBtn.addEventListener("click", abortQuery);

// Global keyboard shortcuts.
//   Cmd/Ctrl+K  → focus the composer input from anywhere
//   Esc         → abort the in-flight query (when not dismissing a menu)
// (Cmd+L is intentionally not bound — it collides with the browser
// address bar; /clear remains available as a slash command.)
document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) {
    e.preventDefault();
    inputEl.focus();
    return;
  }
  if (e.key === "Escape" && inFlight && !slashMenuVisible && !pendingSlashCommand) {
    e.preventDefault();
    abortQuery();
  }
});

inputEl.addEventListener("input", onInputChange);
inputEl.addEventListener("keydown", (e) => {
  // Slash menu nav takes priority when open
  if (slashMenuVisible) {
    if (e.key === "ArrowDown") { e.preventDefault(); moveSlashMenuActive(1); return; }
    if (e.key === "ArrowUp")   { e.preventDefault(); moveSlashMenuActive(-1); return; }
    if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); pickActiveSlashCommand(); return; }
    if (e.key === "Escape") { e.preventDefault(); hideSlashMenu(); return; }
  }
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendUserMessage();
  }
  // ArrowUp on an empty input recalls the last sent prompt for editing
  // and resending (standard chat UX). Only when there's nothing typed
  // and no slash command pending, so it never fights normal cursor nav.
  if (e.key === "ArrowUp" && !inputEl.value && !pendingSlashCommand && lastSentText) {
    e.preventDefault();
    inputEl.value = lastSentText;
    inputEl.setSelectionRange(inputEl.value.length, inputEl.value.length);
    onInputChange();
  }
  if (e.key === "Escape" && pendingSlashCommand) {
    e.preventDefault();
    pendingSlashCommand = null;
    inputEl.placeholder = "Ask Claude… (type / for slash commands · Enter to send · Shift+Enter for newline)";
  }
});

document.querySelectorAll(".suggestion").forEach((btn) => {
  btn.addEventListener("click", () => {
    inputEl.value = btn.dataset.prompt;
    sendUserMessage();
  });
});

// ── multimodal: drag-drop + paste image attachments ──────────────
// The drop zone is the input wrap; the overlay is shown when any drag
// enters the page and hidden on leave or drop. We use a counter to
// handle nested elements correctly (dragenter fires for children).
const inputWrap = document.querySelector(".composer__input-wrap");
const dropOverlay = $("drop-overlay");
let dragCounter = 0;

if (inputWrap && dropOverlay) {
  const showOverlay = () => {
    if (!isMultimodalAllowed()) return;
    dropOverlay.hidden = false;
  };
  const hideOverlay = () => { dropOverlay.hidden = true; };

  // Listen on the whole composer so the overlay catches drags before
  // they reach the textarea.
  document.addEventListener("dragenter", (e) => {
    if (!e.dataTransfer || !Array.from(e.dataTransfer.types).includes("Files")) return;
    dragCounter++;
    showOverlay();
  });
  document.addEventListener("dragleave", () => {
    dragCounter = Math.max(0, dragCounter - 1);
    if (dragCounter === 0) hideOverlay();
  });
  document.addEventListener("dragover", (e) => {
    // Required for drop to fire.
    if (e.dataTransfer && Array.from(e.dataTransfer.types).includes("Files")) {
      e.preventDefault();
    }
  });
  document.addEventListener("drop", async (e) => {
    if (!e.dataTransfer || !e.dataTransfer.files || e.dataTransfer.files.length === 0) return;
    e.preventDefault();
    dragCounter = 0;
    hideOverlay();
    if (!isMultimodalAllowed()) {
      appendErrorMessage("Image attachments require SDK mode (set an Anthropic API key in Nova settings).");
      return;
    }
    for (const f of Array.from(e.dataTransfer.files)) {
      await addAttachmentFromFile(f);
    }
  });
}

// Paste handler — clipboard images (Cmd+V on a screenshot copied via
// Shift+Ctrl+Cmd+4, or images copied from a browser).
inputEl.addEventListener("paste", async (e) => {
  if (!e.clipboardData) return;
  const items = Array.from(e.clipboardData.items || []);
  const imgs = items.filter((it) => it.kind === "file" && it.type.startsWith("image/"));
  if (imgs.length === 0) return;
  if (!isMultimodalAllowed()) {
    appendErrorMessage("Image attachments require SDK mode (set an Anthropic API key in Nova settings).");
    return;
  }
  e.preventDefault();
  for (const it of imgs) {
    const f = it.getAsFile();
    if (f) await addAttachmentFromFile(f);
  }
});

// ── embedded terminal (xterm.js → /cli WS → node-pty `claude`) ─────

let termInstance = null;
let termFitAddon = null;
let termWs = null;
// Which UI requested the next `list_sessions` reply: "chat" routes it to
// the composer's Resume menu, "cli" to the terminal panel's Resume menu.
// Both share the one chat WebSocket, so we tag the request to dispatch
// the single "sessions" reply to the right place.
let pendingSessionsFor = null;
// ── UI preference persistence (localStorage) ──────────────────────
// Layout, model, auto-inject toggle, and the Both-mode splitter ratio
// survive reloads. Same lenient try/catch pattern as the cost tracker.
function uiPrefGet(key) {
  try { return localStorage.getItem("claudecode_ui_" + key); } catch (e) { return null; }
}
function uiPrefSet(key, val) {
  try { localStorage.setItem("claudecode_ui_" + key, String(val)); } catch (e) { /* ignore */ }
}

// Pick the xterm.js theme object matching the current data-theme
// attribute on <html>. Re-called whenever the page theme changes.
function currentTerminalTheme() {
  const t = document.documentElement.getAttribute("data-theme");
  if (t === "light") {
    return { background: "#ffffff", foreground: "#1d1d1f", cursor: "#1d1d1f" };
  }
  return { background: "#1e1e22", foreground: "#e8e8ea", cursor: "#e8e8ea" };
}

function ensureTerminal() {
  if (termInstance) {
    // Terminal UI already built. If the PTY exited (ws closed → termWs
    // null), reconnect so a fresh `claude` spawns. This is what makes
    // "switch layout to reconnect" — and the Restart button — actually
    // work after the user quits claude.
    if (!termWs) connectTerminalWs();
    return termInstance;
  }
  if (typeof Terminal === "undefined") return null; // xterm.js not loaded yet
  const host = document.getElementById("terminal-host");
  if (!host) return null;

  termInstance = new Terminal({
    cursorBlink: true,
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    fontSize: 12,
    theme: currentTerminalTheme(),
  });
  if (typeof FitAddon !== "undefined" && FitAddon.FitAddon) {
    termFitAddon = new FitAddon.FitAddon();
    termInstance.loadAddon(termFitAddon);
  }
  termInstance.open(host);
  if (termFitAddon) {
    try { termFitAddon.fit(); } catch (_) {}
  }
  termInstance.onData((data) => {
    if (termWs && termWs.readyState === WebSocket.OPEN) {
      termWs.send(JSON.stringify({ type: "input", data }));
    }
  });
  connectTerminalWs();
  // Resize the PTY whenever the terminal element changes size.
  window.addEventListener("resize", () => {
    if (termFitAddon) {
      try {
        termFitAddon.fit();
        const cols = termInstance.cols, rows = termInstance.rows;
        if (termWs && termWs.readyState === WebSocket.OPEN) {
          termWs.send(JSON.stringify({ type: "resize", cols, rows }));
        }
      } catch (_) {}
    }
  });
  return termInstance;
}

function connectTerminalWs(sessionIdToResume) {
  if (termWs) return;
  // Reconnecting with ?session=<id> tells cli-session to spawn the
  // PTY with --resume <id>. Used by the resume flows.
  const qs = sessionIdToResume ? `?session=${encodeURIComponent(sessionIdToResume)}` : "";
  const url = `ws://${location.host}/cli${qs}`;
  termWs = new WebSocket(url);
  // Capture this socket so handlers can tell whether they belong to the
  // CURRENT connection. Without this, an old socket's late `close` event
  // would null out `termWs` even after a restart already opened a new one.
  const sock = termWs;
  sock.addEventListener("message", (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    if (msg.type === "output" && termInstance) termInstance.write(msg.data);
    if (msg.type === "exit" && termInstance) termInstance.write(`\r\n\x1b[33m[claude exited code=${msg.code}]\x1b[0m\r\n`);
    if (msg.type === "resume_external" && msg.sessionId) {
      // Bring the CLI panel to view, then reconnect so the new PTY
      // launches with --resume <id>.
      if (panelsEl && termPanel.hidden) setLayout("cli");
      if (termInstance) {
        termInstance.write(`\r\n\x1b[36m[resuming session ${msg.sessionId.slice(0, 8)}…]\x1b[0m\r\n`);
        termInstance.clear();
      }
      try { sock.close(); } catch (_) {}
      if (termWs === sock) termWs = null;
      connectTerminalWs(msg.sessionId);
    }
  });
  sock.addEventListener("close", () => {
    // Only react if this is still the active socket — a stale close from
    // a just-replaced connection must not clobber the new termWs.
    if (termWs !== sock) return;
    termWs = null;
    if (termInstance) termInstance.write("\r\n\x1b[90m[claude session ended — click ↻ Restart to relaunch]\x1b[0m\r\n");
  });
  sock.addEventListener("error", () => {
    if (termWs === sock && termInstance) termInstance.write("\r\n\x1b[31m[terminal ws error]\x1b[0m\r\n");
  });
}

// Layout toggle — Chat only / Both / CLI only
const panelsEl   = document.getElementById("panels");
const termPanel  = document.getElementById("terminal-panel");
const chatPanel  = document.getElementById("chat-panel"); // wraps chat history + composer
const splitterEl = document.getElementById("splitter");

// Draggable splitter — only active in Both mode. Adjusts the flex
// basis of the two panels live as the user drags the divider.
if (splitterEl) {
  let dragging = false;
  let startY = 0;
  let startTermPct = 50; // % of panels height occupied by terminal at drag start

  splitterEl.addEventListener("mousedown", (e) => {
    dragging = true;
    splitterEl.classList.add("dragging");
    startY = e.clientY;
    const totalH = panelsEl.getBoundingClientRect().height;
    const termH  = termPanel.getBoundingClientRect().height;
    startTermPct = totalH > 0 ? (termH / totalH) * 100 : 50;
    // Block text selection while dragging
    document.body.style.userSelect = "none";
    e.preventDefault();
  });

  window.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    const totalH = panelsEl.getBoundingClientRect().height;
    if (totalH <= 0) return;
    const deltaPct = ((e.clientY - startY) / totalH) * 100;
    let pct = startTermPct + deltaPct;
    // Clamp so neither panel collapses entirely
    pct = Math.max(10, Math.min(90, pct));
    termPanel.style.flex  = `0 0 ${pct}%`;
    chatPanel.style.flex  = `1 1 auto`;
    // Re-fit the xterm terminal so its grid matches the new pixel height
    if (termFitAddon && termInstance) {
      try { termFitAddon.fit(); } catch (_) {}
    }
  });

  window.addEventListener("mouseup", () => {
    if (!dragging) return;
    dragging = false;
    splitterEl.classList.remove("dragging");
    document.body.style.userSelect = "";
    // Persist the split ratio so Both mode restores it next time.
    const totalH = panelsEl.getBoundingClientRect().height;
    const termH = termPanel.getBoundingClientRect().height;
    if (totalH > 0) uiPrefSet("splitPct", ((termH / totalH) * 100).toFixed(1));
    // Final resize signal to the PTY
    if (termInstance && termWs && termWs.readyState === WebSocket.OPEN) {
      termWs.send(JSON.stringify({ type: "resize", cols: termInstance.cols, rows: termInstance.rows }));
    }
  });
}
const layoutBtns = {
  chat: document.getElementById("layout-chat"),
  both: document.getElementById("layout-both"),
  cli:  document.getElementById("layout-cli"),
};

function setLayout(mode) {
  // Reset any inline flex left over from a previous drag so the
  // default 50/50 applies next time the user comes back to Both.
  termPanel.style.flex = "";
  chatPanel.style.flex = "";

  if (mode === "chat") {
    chatPanel.hidden = false;
    termPanel.hidden = true;
    if (splitterEl) splitterEl.hidden = true;
    panelsEl.classList.remove("panels--split");
  } else if (mode === "cli") {
    chatPanel.hidden = true;
    termPanel.hidden = false;
    if (splitterEl) splitterEl.hidden = true;
    panelsEl.classList.remove("panels--split");
    ensureTerminal();
  } else if (mode === "both") {
    chatPanel.hidden = false;
    termPanel.hidden = false;
    if (splitterEl) splitterEl.hidden = false;
    panelsEl.classList.add("panels--split");
    ensureTerminal();
    // Restore the saved split ratio (overrides the flex reset above).
    const savedPct = parseFloat(uiPrefGet("splitPct"));
    if (!isNaN(savedPct)) {
      termPanel.style.flex = `0 0 ${savedPct}%`;
      chatPanel.style.flex = "1 1 auto";
    }
  }
  uiPrefSet("layout", mode);
  for (const k of Object.keys(layoutBtns)) {
    layoutBtns[k]?.classList.toggle("active", k === mode);
  }
  // Re-fit after the layout has reflowed
  if (termInstance && termFitAddon) {
    requestAnimationFrame(() => {
      try {
        termFitAddon.fit();
        const cols = termInstance.cols, rows = termInstance.rows;
        if (termWs && termWs.readyState === WebSocket.OPEN) {
          termWs.send(JSON.stringify({ type: "resize", cols, rows }));
        }
      } catch (_) {}
    });
  }
}

if (layoutBtns.chat) layoutBtns.chat.addEventListener("click", () => setLayout("chat"));
if (layoutBtns.both) layoutBtns.both.addEventListener("click", () => setLayout("both"));
if (layoutBtns.cli)  layoutBtns.cli.addEventListener("click",  () => setLayout("cli"));

// Restart the CLI panel's claude session. Spawns a fresh PTY without
// reloading the page — fixes the dead-end where quitting claude left
// the panel with no way back. If the terminal was never built (xterm
// not loaded / panel never shown), ensureTerminal() builds it; if it
// exists but the ws is closed, ensureTerminal() reconnects.
function restartTerminal() {
  if (termInstance && termWs) {
    // A live session is running — tear it down first so the close
    // handler fires and the backend kills the old PTY, then reconnect.
    termInstance.write("\r\n\x1b[36m[restarting claude…]\x1b[0m\r\n");
    try { termWs.close(); } catch (_) {}
    termWs = null;
  } else if (termInstance) {
    termInstance.write("\r\n\x1b[36m[starting claude…]\x1b[0m\r\n");
  }
  ensureTerminal(); // builds and/or reconnects
}

const termRestartBtn = document.getElementById("term-restart");
if (termRestartBtn) termRestartBtn.addEventListener("click", restartTerminal);

// CLI panel Resume — list the workspace's past sessions and relaunch
// the terminal with `claude --resume <id>`. Reuses the chat backend's
// list_sessions (same session list) and the terminal's ?session= path.
const termResumeMenu = document.getElementById("term-resume-menu");

function showTermResumeMenu(sessions) {
  if (!termResumeMenu) return;
  if (!sessions || sessions.length === 0) {
    termResumeMenu.innerHTML = `<div class="resume-menu__empty">No previous sessions for this workspace.</div>`;
  } else {
    termResumeMenu.innerHTML = sessions.map((s) => `
      <button class="resume-menu__item" data-sid="${s.sessionId}" title="${escapeHtml(s.sessionId)}">
        <span class="resume-menu__preview">${escapeHtml(s.preview || "(empty session)")}</span>
        <span class="resume-menu__meta">
          <span class="resume-menu__sid">${escapeHtml(s.sessionId)}</span>
          <span>${relativeTimeShort(s.mtimeMs)}${s.gitBranch ? " · " + escapeHtml(s.gitBranch) : ""}</span>
        </span>
      </button>
    `).join("");
    termResumeMenu.querySelectorAll(".resume-menu__item").forEach((el) => {
      el.addEventListener("mousedown", (e) => {
        e.preventDefault();
        resumeTerminalSession(el.dataset.sid, el.querySelector(".resume-menu__preview")?.textContent || "");
      });
    });
  }
  termResumeMenu.hidden = false;
}

function hideTermResumeMenu() {
  if (termResumeMenu) termResumeMenu.hidden = true;
}

// Relaunch the CLI panel's claude with --resume <id>. Modeled on the
// resume_external flow (sidebar-initiated resume): show the panel,
// announce, tear down the current PTY, reconnect with the session.
function resumeTerminalSession(sessionId, preview) {
  hideTermResumeMenu();
  if (panelsEl && termPanel.hidden) setLayout("cli");
  ensureTerminal();
  if (termInstance) {
    termInstance.write(`\r\n\x1b[36m[resuming session ${sessionId.slice(0, 8)}…${preview ? " — " + preview : ""}]\x1b[0m\r\n`);
    try { termInstance.clear(); } catch (_) {}
  }
  if (termWs) { try { termWs.close(); } catch (_) {} termWs = null; }
  connectTerminalWs(sessionId);
}

const termResumeBtn = document.getElementById("term-resume");
if (termResumeBtn) {
  termResumeBtn.addEventListener("click", () => {
    if (termResumeMenu && !termResumeMenu.hidden) { hideTermResumeMenu(); return; }
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      if (termInstance) termInstance.write("\r\n\x1b[31m[cannot list sessions — chat backend not connected]\x1b[0m\r\n");
      return;
    }
    pendingSessionsFor = "cli";
    ws.send(JSON.stringify({ type: "list_sessions" }));
    if (termResumeMenu) {
      termResumeMenu.innerHTML = `<div class="resume-menu__empty">Loading sessions…</div>`;
      termResumeMenu.hidden = false;
    }
  });
}

// Close the CLI resume menu on outside click.
document.addEventListener("mousedown", (e) => {
  if (termResumeMenu && !termResumeMenu.hidden &&
      !termResumeMenu.contains(e.target) && e.target !== termResumeBtn) {
    hideTermResumeMenu();
  }
});

if (modelPicker) {
  modelPicker.addEventListener("change", () => {
    uiPrefSet("model", modelPicker.value);
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: "set_model", model: modelPicker.value }));
    chatStatus.model = modelPicker.value;
    renderChatStatus();
  });
}

// ── resume previous session ────────────────────────────────────────

const resumeBtn  = document.getElementById("resume");
const resumeMenu = document.getElementById("resume-menu");

function showResumeMenu(sessions) {
  if (!resumeMenu) return;
  if (!sessions || sessions.length === 0) {
    resumeMenu.innerHTML = `<div class="resume-menu__empty">No previous sessions for this workspace.</div>`;
  } else {
    resumeMenu.innerHTML = sessions.map((s) => `
      <button class="resume-menu__item" data-sid="${s.sessionId}" title="${escapeHtml(s.sessionId)}">
        <span class="resume-menu__preview">${escapeHtml(s.preview || "(empty session)")}</span>
        <span class="resume-menu__meta">
          <span class="resume-menu__sid">${escapeHtml(s.sessionId)}</span>
          <span>${relativeTimeShort(s.mtimeMs)}${s.gitBranch ? " · " + escapeHtml(s.gitBranch) : ""}</span>
        </span>
      </button>
    `).join("");
    resumeMenu.querySelectorAll(".resume-menu__item").forEach((el) => {
      el.addEventListener("mousedown", (e) => {
        e.preventDefault();
        pickResumeSession(el.dataset.sid, el.querySelector(".resume-menu__preview")?.textContent || "");
      });
    });
  }
  resumeMenu.hidden = false;
}

function hideResumeMenu() {
  if (resumeMenu) resumeMenu.hidden = true;
}

function pickResumeSession(sessionId, preview) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: "resume_session", sessionId }));
  hideResumeMenu();
  // Visual hint in the transcript so the user remembers the chat is
  // now picking up from a previous session.
  const note = document.createElement("div");
  note.className = "resume-note";
  note.textContent = `↻ Resuming session ${sessionId.slice(0, 8)}…${preview ? " — " + preview : ""}`;
  chatEl.appendChild(note);
  hideEmptyState();
  scrollToBottom();
}

function relativeTimeShort(ts) {
  const diff = (Date.now() - ts) / 1000;
  if (diff < 60)        return Math.floor(diff) + "s ago";
  if (diff < 3600)      return Math.floor(diff / 60) + "m ago";
  if (diff < 86400)     return Math.floor(diff / 3600) + "h ago";
  if (diff < 86400*30)  return Math.floor(diff / 86400) + "d ago";
  return new Date(ts).toLocaleDateString();
}

// Open the composer session menu to resume a past conversation in-place.
function openSessionMenu() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  if (resumeMenu && !resumeMenu.hidden) { hideResumeMenu(); return; }
  pendingSessionsFor = "chat"; // routes the reply to showResumeMenu()
  ws.send(JSON.stringify({ type: "list_sessions" }));
  if (resumeMenu) {
    resumeMenu.innerHTML = `<div class="resume-menu__empty">Loading sessions…</div>`;
    resumeMenu.hidden = false;
  }
}

if (resumeBtn) resumeBtn.addEventListener("click", () => openSessionMenu());

// Remote sessions (running in the cloud / on a server via
// `claude remote-control`) are listed and joined from claude.ai/code —
// the local CLI has no command to enumerate or attach to them. So the
// Remote button just opens that client. Falls back to copying the URL
// when the popup is blocked (common inside Nova's WebKit Preview).
const liveBtn = document.getElementById("remote-control");

// Live sessions — list the claude sessions currently running on THIS
// machine (`claude agents --json`, via the chat backend) and jump into
// the picked one in the CLI panel with `claude --resume <id>`.
function showLiveSessionsMenu(sessions) {
  if (!resumeMenu) return;
  if (!sessions || sessions.length === 0) {
    resumeMenu.innerHTML = `<div class="resume-menu__empty">No live claude sessions running on this machine.</div>`;
  } else {
    resumeMenu.innerHTML = sessions.map((s) => {
      const sid = s.sessionId || "";
      const dir = s.cwd ? s.cwd.split("/").pop() : "?";
      const status = s.status || "";
      const started = s.startedAt ? relativeTimeShort(s.startedAt) : "";
      return `
      <button class="resume-menu__item" data-sid="${sid}" title="${escapeHtml(s.cwd || sid)}">
        <span class="resume-menu__preview">${escapeHtml(dir)}${status ? ` · ${escapeHtml(status)}` : ""}</span>
        <span class="resume-menu__meta">
          <span class="resume-menu__sid">${escapeHtml(sid)}</span>
          <span>${escapeHtml(started)}${s.pid ? " · pid " + s.pid : ""}</span>
        </span>
      </button>`;
    }).join("");
    resumeMenu.querySelectorAll(".resume-menu__item").forEach((el) => {
      el.addEventListener("mousedown", (e) => {
        e.preventDefault();
        attachLiveSession(el.dataset.sid);
      });
    });
  }
  resumeMenu.hidden = false;
}

// Jump into a running session: open the CLI panel and resume it there.
function attachLiveSession(sessionId) {
  hideResumeMenu();
  if (!sessionId) return;
  if (panelsEl && termPanel.hidden) setLayout("cli");
  ensureTerminal();
  if (termInstance) {
    termInstance.write(`\r\n\x1b[36m[attaching to live session ${sessionId.slice(0, 8)}…]\x1b[0m\r\n`);
    try { termInstance.clear(); } catch (_) {}
  }
  if (termWs) { try { termWs.close(); } catch (_) {} termWs = null; }
  connectTerminalWs(sessionId);
}

function openLiveSessions() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  if (resumeMenu && !resumeMenu.hidden) { hideResumeMenu(); return; }
  ws.send(JSON.stringify({ type: "list_live_sessions" }));
  if (resumeMenu) {
    resumeMenu.innerHTML = `<div class="resume-menu__empty">Scanning live sessions…</div>`;
    resumeMenu.hidden = false;
  }
}

if (liveBtn) liveBtn.addEventListener("click", openLiveSessions);

// ── export conversation to Markdown ───────────────────────────────
// Serializes the visible transcript (user/assistant messages + a
// compact note for each tool call) and downloads it as a .md file.
function buildConversationMarkdown() {
  const lines = [];
  lines.push("# Claude Code — Nova chat export");
  lines.push("");
  lines.push(`_Exported ${new Date().toLocaleString()}_`);
  if (currentSessionId) lines.push(`Session: \`${currentSessionId}\``);
  lines.push("");
  for (const el of chatEl.children) {
    if (el.classList.contains("msg")) {
      const body = el.querySelector(".msg__body");
      if (!body) continue;
      const who = el.classList.contains("msg--user") ? "You" : "Claude";
      lines.push(`## ${who}`, "", body.innerText.trim(), "");
    } else if (el.classList.contains("tool")) {
      const name = el.querySelector(".tool__name")?.textContent?.trim() || "tool";
      lines.push(`> tool: ${name}`, "");
    } else if (el.classList.contains("error-msg")) {
      lines.push(`> error: ${el.innerText.trim()}`, "");
    }
  }
  return lines.join("\n");
}

function exportConversation() {
  const md = buildConversationMarkdown();
  try {
    const blob = new Blob([md], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `claude-chat-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.md`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (e) {
    // Fallback for environments where anchor-download is blocked:
    // drop the markdown on the clipboard instead.
    navigator.clipboard?.writeText(md);
  }
}

const exportBtn = document.getElementById("export-md");
if (exportBtn) exportBtn.addEventListener("click", exportConversation);

// Close the resume menu when clicking outside.
document.addEventListener("mousedown", (e) => {
  if (resumeMenu && !resumeMenu.hidden && !resumeMenu.contains(e.target) && e.target !== resumeBtn && e.target !== liveBtn) {
    hideResumeMenu();
  }
});

// The CLI's init event sometimes returns the model with a "[1m]" suffix
// (e.g. "claude-opus-4-8[1m]"). The picker stores the plain ID — strip
// the suffix before assigning so the option stays selected.
function stripModelSuffix(m) {
  return m.replace(/\[[^\]]+\]$/, "");
}

// Drive the page theme via a data-theme="dark|light" attribute on
// <html>. The CSS uses :root[data-theme="light"] / fallback to the
// default dark for everything else. JS resolves "auto" against
// matchMedia so it follows macOS, and listens for OS changes when
// auto is in effect.
let themeMediaQuery = null;
let themeMediaListener = null;
function applyTheme(theme) {
  const root = document.documentElement;
  // Detach any previous OS listener; we re-attach only for "auto".
  if (themeMediaQuery && themeMediaListener) {
    themeMediaQuery.removeEventListener("change", themeMediaListener);
    themeMediaListener = null;
  }

  if (theme === "dark" || theme === "light") {
    root.setAttribute("data-theme", theme);
    syncTerminalTheme();
    return;
  }

  // "auto" (or undefined) → follow the OS appearance preference and
  // keep updating if it changes while the page is open.
  themeMediaQuery = window.matchMedia("(prefers-color-scheme: light)");
  const sync = () => {
    root.setAttribute("data-theme", themeMediaQuery.matches ? "light" : "dark");
    syncTerminalTheme();
  };
  sync();
  themeMediaListener = sync;
  themeMediaQuery.addEventListener("change", themeMediaListener);
}

// Push the current data-theme into the running xterm.js instance, if
// any. Called from applyTheme() so the terminal background follows
// the rest of the chrome instead of staying stuck on its boot value.
function syncTerminalTheme() {
  if (!termInstance) return;
  try { termInstance.options.theme = currentTerminalTheme(); }
  catch (_) {}
}

// Apply the OS-resolved theme at boot so the page isn't a flash of
// the wrong colors before the WS `config` event arrives.
applyTheme("auto");

// State we accumulate from the WS so we can render a stable chat
// status line (mode · model · port) regardless of which event last
// arrived. Updated on `config`, `session_started`, and model picker
// `change`. Re-rendered into the right-hand statusbar item via
// renderChatStatus().
const chatStatus = { mode: null, model: null, port: location.port || "5180" };
function renderChatStatus() {
  const dot = document.getElementById("chat-dot");
  const txt = document.getElementById("chat-status-text");
  if (!dot || !txt) return;
  const bits = ["Chat:"];
  if (chatStatus.mode) bits.push(chatStatus.mode === "cli" ? "OAuth" : chatStatus.mode.toUpperCase());
  if (chatStatus.model) bits.push(chatStatus.model.replace(/^claude-/, ""));
  bits.push("port " + chatStatus.port);
  txt.textContent = bits.join(" · ");
  dot.className = "dot dot--connected";
}

// Render the auth/runtime mode badge (CLI vs SDK) into the meta bar.
// Shared between the initial `config` event and per-session updates.
function applyModeBadge(mode) {
  if (!metaMode) return;
  if (mode === "cli") {
    metaMode.textContent = "OAuth";
    metaMode.title = "Claude Code OAuth session — covered by your Pro/Max subscription";
    metaMode.className = "meta-mode meta-mode--cli";
    metaMode.hidden = false;
  } else if (mode === "sdk") {
    metaMode.textContent = "SDK";
    metaMode.title = "Anthropic API key — billed per token";
    metaMode.className = "meta-mode meta-mode--sdk";
    metaMode.hidden = false;
  }
}

// ── boot ──────────────────────────────────────────────────────────

window.addEventListener("load", () => {
  // Surface the persisted daily total right away so the user sees their
  // running cost from previous sessions today, even before sending the
  // first message.
  renderCostMeta(null, null);

  // Show the context gauge as a discoverable placeholder until the first
  // reply gives us real input_tokens to compute from.
  {
    const ctx = document.getElementById("meta-ctx");
    if (ctx) {
      ctx.textContent = "ctx —";
      ctx.title = "Context-window usage — appears after the first reply";
    }
  }

  // Restore persisted UI prefs. Model is restored here visually; the
  // backend is re-told on session_started. Inject toggle + layout too.
  const savedModel = uiPrefGet("model");
  if (savedModel && modelPicker) modelPicker.value = savedModel;
  if (injectCtxEl) {
    const savedInject = uiPrefGet("inject");
    if (savedInject !== null) injectCtxEl.checked = savedInject === "1";
    injectCtxEl.addEventListener("change", () => uiPrefSet("inject", injectCtxEl.checked ? "1" : "0"));
  }
  const savedLayout = uiPrefGet("layout");
  if (savedLayout === "cli" || savedLayout === "both") setLayout(savedLayout);

  // Wait for marked + hljs to be available
  const tryStart = () => {
    if (setupMarked() && typeof hljs !== "undefined") {
      connect();
    } else {
      setTimeout(tryStart, 80);
    }
  };
  tryStart();
});
