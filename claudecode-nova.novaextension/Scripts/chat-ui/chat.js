// chat.js — chat UI client: WebSocket + markdown render + tool cards + copy.
//
// Single-file vanilla JS. No bundler. Uses globals from CDN scripts :
//   - marked (markdown parser)
//   - hljs   (highlight.js)

const $ = (id) => document.getElementById(id);

const chatEl     = $("chat");
const inputEl    = $("input");
const sendBtn    = $("send");
const abortBtn   = $("abort");
const statusDot  = $("status-dot");
const statusText = $("status-text");
const emptyState = $("empty-state");
const metaSess   = $("meta-session");
const metaCost   = $("meta-cost");

let ws = null;
let inFlight = false;
let currentAssistantBubble = null;
let currentAssistantBuffer = "";
let toolCardsByName = []; // queue of cards waiting for a matching tool_result

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
  if (!text || inFlight || !ws || ws.readyState !== WebSocket.OPEN) return;
  inFlight = true;
  appendUserMessage(text);
  ws.send(JSON.stringify({ type: "user_message", text }));
  inputEl.value = "";
  sendBtn.disabled = true;
  abortBtn.hidden = false;
  setStatus("thinking", "Sending…");
}

function abortQuery() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: "abort" }));
}

// ── input wiring ──────────────────────────────────────────────────

sendBtn.addEventListener("click", sendUserMessage);
abortBtn.addEventListener("click", abortQuery);

inputEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendUserMessage();
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
