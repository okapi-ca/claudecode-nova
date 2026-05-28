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
const slashMenuEl  = $("slash-menu");
const injectCtxEl  = $("inject-context");

let ws = null;
let inFlight = false;
let currentAssistantBubble = null;
let currentAssistantBuffer = "";
let toolCardsByName = []; // queue of cards waiting for a matching tool_result

// Slash commands available from the composer. The `cmd` value is sent
// to the backend, which maps it to a templated prompt. The `desc` is
// only used for the menu label.
const SLASH_COMMANDS = [
  { cmd: "explain",  label: "/explain",  desc: "Explain the selected code" },
  { cmd: "refactor", label: "/refactor", desc: "Refactor for clarity" },
  { cmd: "test",     label: "/test",     desc: "Write tests" },
  { cmd: "doc",      label: "/doc",      desc: "Add inline documentation" },
  { cmd: "fix",      label: "/fix",      desc: "Find and fix bugs" },
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
  const body = ensureAssistantBubble();
  currentAssistantBuffer += chunk;
  body.innerHTML = renderMarkdown(currentAssistantBuffer);
  highlightCodeBlocks(body);
  scrollToBottom();
}

function appendToolCard(name, input) {
  hideEmptyState();
  // Close any open assistant bubble so the next assistant_text starts a new one
  currentAssistantBubble = null;
  currentAssistantBuffer = "";

  const card = document.createElement("div");
  card.className = "tool";
  const summary = Object.keys(input).length
    ? JSON.stringify(input)
    : "(no args)";
  card.innerHTML = `
    <div class="tool__header" role="button">
      <span class="tool__icon"></span>
      <span class="tool__name">${escapeHtml(prettyToolName(name))}</span>
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

  if (isError) target.classList.add("error");

  const label = target.querySelector(".tool__result-label");
  const pre   = target.querySelector(".tool__result");
  label.hidden = false;
  pre.hidden = false;
  pre.textContent = text;
}

function prettyToolName(name) {
  // "mcp__nova__nova_openFile" → "nova_openFile"
  return name.replace(/^mcp__[^_]+__/, "");
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
    case "session_started":
      metaSess.textContent = `session ${msg.sessionId.slice(0, 8)}… · model ${msg.model}`;
      setStatus("thinking", "Claude is working…");
      break;

    case "assistant_text":
      appendAssistantText(msg.chunk);
      break;

    case "assistant_tool_use":
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
      break;
  }
}

function setStatus(kind, text) {
  statusDot.className = "dot dot--" + kind;
  statusText.textContent = text;
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
