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
  { cmd: "commit",   label: "/commit",   desc: "Draft a commit message from current diff" },
];

// When the user picks a slash command, we send it as a flag and clear
// the input. Setting this here so the next send() picks it up.
let pendingSlashCommand = null;
let slashMenuVisible = false;
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
    addCopyButton(block.parentElement); // the <pre>
  });
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
  scrollToBottom();
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
  scrollToBottom();
}

function appendErrorMessage(text) {
  const el = document.createElement("div");
  el.className = "error-msg";
  el.textContent = "Error: " + text;
  chatEl.appendChild(el);
  scrollToBottom();
}

function scrollToBottom() {
  chatEl.scrollTop = chatEl.scrollHeight;
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
      showResumeMenu(msg.sessions || []);
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
      applyModeBadge(msg.mode);
      // Sync the picker to the model the backend actually started with —
      // it may differ from the picker's default if the user configured
      // something else in extension settings. Don't fire `change`.
      if (msg.model && modelPicker) {
        modelPicker.value = stripModelSuffix(msg.model);
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
        const tk = msg.tokens
          ? ` · in ${msg.tokens.input} / out ${msg.tokens.output} tk`
          : "";
        metaCost.textContent = `last cost $${msg.cost.toFixed(4)}${tk}`;
      } else if (!msg.success) {
        appendErrorMessage(msg.error || "query failed");
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
  // A slash command can be sent without extra text; otherwise require text.
  if ((!text && !pendingSlashCommand) || inFlight || !ws || ws.readyState !== WebSocket.OPEN) return;
  inFlight = true;

  const injectContext = !!(injectCtxEl && injectCtxEl.checked);
  const slashCommand  = pendingSlashCommand;

  // Visual representation: prepend the slash label so the user sees
  // which command was used in the transcript.
  const displayText = slashCommand
    ? `/${slashCommand}${text ? " " + text : ""}`
    : text;
  appendUserMessage(displayText);

  ws.send(JSON.stringify({
    type: "user_message",
    text,
    slashCommand,
    injectContext,
  }));

  inputEl.value = "";
  pendingSlashCommand = null;
  hideSlashMenu();
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
  pendingSlashCommand = cmd;
  // Clear the "/foo" the user typed and let them add extra context if they want
  inputEl.value = "";
  inputEl.placeholder = `/${cmd} — add any extra context, then press Enter (or Enter again to send as-is)`;
  hideSlashMenu();
  inputEl.focus();
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

// ── embedded terminal (xterm.js → /cli WS → node-pty `claude`) ─────

let termInstance = null;
let termFitAddon = null;
let termWs = null;

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
  if (termInstance) return termInstance;
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
  // PTY with --resume <id>. Used by the Nova sidebar "CLI panel"
  // action.
  const qs = sessionIdToResume ? `?session=${encodeURIComponent(sessionIdToResume)}` : "";
  const url = `ws://${location.host}/cli${qs}`;
  termWs = new WebSocket(url);
  termWs.addEventListener("message", (e) => {
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
      try { termWs && termWs.close(); } catch (_) {}
      termWs = null;
      connectTerminalWs(msg.sessionId);
    }
  });
  termWs.addEventListener("close", () => {
    termWs = null;
    if (termInstance) termInstance.write("\r\n\x1b[90m[terminal disconnected — switch layout to reconnect]\x1b[0m\r\n");
  });
  termWs.addEventListener("error", () => {
    if (termInstance) termInstance.write("\r\n\x1b[31m[terminal ws error]\x1b[0m\r\n");
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
  }
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

if (modelPicker) {
  modelPicker.addEventListener("change", () => {
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

if (resumeBtn) {
  resumeBtn.addEventListener("click", () => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (resumeMenu && !resumeMenu.hidden) { hideResumeMenu(); return; }
    ws.send(JSON.stringify({ type: "list_sessions" }));
    // The "sessions" reply will trigger showResumeMenu(). Show a
    // momentary loading state.
    if (resumeMenu) {
      resumeMenu.innerHTML = `<div class="resume-menu__empty">Loading sessions…</div>`;
      resumeMenu.hidden = false;
    }
  });
}

// Close the resume menu when clicking outside.
document.addEventListener("mousedown", (e) => {
  if (resumeMenu && !resumeMenu.hidden && !resumeMenu.contains(e.target) && e.target !== resumeBtn) {
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
  if (chatStatus.mode) bits.push(chatStatus.mode.toUpperCase());
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
    metaMode.textContent = "CLI";
    metaMode.title = "Claude Code OAuth session — covered by subscription";
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
