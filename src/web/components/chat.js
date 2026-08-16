/**
 * Chat component: transcript, message rendering, reasoning, and message composer.
 *
 * Rules:
 *   - mobile friendly with 44px tap targets;
 *   - Ctrl+Enter/Meta+Enter sends message, Enter creates newline;
 *   - autogrowing textarea bounded by visual viewport height.
 */

import { $, el, t, fail } from "../helpers.js";
import { renderRich, toolRow, finishToolRow } from "./toolcard.js";
import { renderRich as renderMarkdownRich } from "../markdown.js";
import { api } from "../api.js";
import { setStatus } from "./statusbar.js";

export const messagesEl = () => $("messages");
export const BUSY = () => t("chat.working");

let stick = true;
let turn = null;
const dirtyBlocks = new Set();
let rafPending = false;

export function getTurn() {
  return turn;
}

export function setTurn(tVal) {
  turn = tVal;
}

export function getStick() {
  return stick;
}

export function setStick(val) {
  stick = val;
}

export function scrollToBottom(force) {
  const m = messagesEl();
  if (!m) return;
  if (force) {
    stick = true;
    const jump = $("jump-latest");
    if (jump) jump.hidden = true;
  }
  if (stick) m.scrollTop = m.scrollHeight;
}

export function messageHost() {
  const m = messagesEl();
  if (!m) return document.body;
  const placeholder = m.querySelector(".empty");
  if (placeholder) placeholder.remove();
  return m;
}

export function makeBubble(role) {
  const bubble = el("article", `msg ${role}`);
  bubble.setAttribute("aria-label", role === "user" ? t("chat.you") : t("chat.assistant"));
  bubble.appendChild(el("div", "msg-gutter", role === "user" ? t("chat.you") : t("chat.assistant")));
  const body = el("div", "msg-body");
  bubble.appendChild(body);
  messageHost().appendChild(bubble);
  return { bubble, body };
}

export function footerOf(tRef) {
  if (!tRef.footer) tRef.bubble.appendChild((tRef.footer = el("p", "msg-footer")));
  return tRef.footer;
}

export function ensureTurn() {
  if (turn) return turn;
  const { bubble, body } = makeBubble("assistant");
  turn = { bubble, body, text: null, footer: null, tools: new Map(), subs: new Map(), reasoning: null };
  scrollToBottom();
  return turn;
}

export function hostFor(ev) {
  const cur = ensureTurn();
  if (ev && ev.subagent) {
    const sub = cur.subs.get(String(ev.subagent));
    if (sub) return sub.body;
  }
  return cur.body;
}

export function reasoningBlock() {
  const cur = ensureTurn();
  if (cur.reasoning) return cur.reasoning;
  const sum = el("summary");
  sum.append(el("span", "tool-caret", "\u203a"), el("span", "tool-name", t("chat.thinking")));
  const node = el("div", "reason-body");
  const block = el("details", "reasoning");
  block.append(sum, node);
  cur.body.appendChild(block);
  cur.text = null;
  cur.reasoning = { block, node, raw: "" };
  return cur.reasoning;
}

export function scheduleRender(block) {
  dirtyBlocks.add(block);
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(flushRender);
}

export function flushRender() {
  rafPending = false;
  for (const b of dirtyBlocks) {
    if (b.plain) b.node.textContent = b.raw;
    else renderMarkdownRich(b.node, b.raw);
  }
  dirtyBlocks.clear();
  scrollToBottom();
}

export function clearDirtyBlocks() {
  dirtyBlocks.clear();
}

export function appendDelta(text, ev) {
  const cur = ensureTurn();
  const host = hostFor(ev);
  const sub = ev && ev.subagent ? cur.subs.get(String(ev.subagent)) : null;
  const slot = sub || cur;
  if (!slot.text) {
    const node = el("div", "rich");
    host.appendChild(node);
    slot.text = { node, raw: "" };
  }
  slot.text.raw += String(text);
  scheduleRender(slot.text);
}

export function appendReasoning(text) {
  const block = reasoningBlock();
  block.raw += String(text);
  block.plain = true;
  scheduleRender(block);
}

export function noteLine(text, kind = "info", ev) {
  const host = turn ? hostFor(ev) : messageHost();
  host.appendChild(el("p", `tool-note ${kind}`, String(text)));
  if (turn) {
    const sub = ev && ev.subagent ? turn.subs.get(String(ev.subagent)) : null;
    (sub || turn).text = null;
  }
  scrollToBottom();
}

export function renderStoredMessage(msg, results) {
  const role = msg.role === "user" ? "user" : "assistant";
  const { body } = makeBubble(role);
  if (role === "user") {
    body.appendChild(el("div", "prose", String(msg.content ?? "")));
    return;
  }
  if (msg.reasoning) {
    const sum = el("summary");
    sum.append(el("span", "tool-caret", "\u203a"), el("span", "tool-name", t("chat.thinking")));
    const block = el("details", "reasoning");
    block.append(sum, el("div", "reason-body", String(msg.reasoning)));
    body.appendChild(block);
  }
  if (msg.content) {
    const rich = el("div", "rich");
    renderMarkdownRich(rich, String(msg.content));
    body.appendChild(rich);
  }
  for (const call of msg.toolCalls || []) {
    const got = results && results.get(String(call.id));
    const handle = toolRow(body, call.name, call.input);
    if (got) finishToolRow(handle, got.ok !== false, got.output);
    else handle.badge.textContent = t("tool.unknown");
  }
  if (msg.usage && (msg.usage.input || msg.usage.output)) {
    body.appendChild(
      el("p", "msg-footer", t("chat.tokens", { in: msg.usage.input || 0, out: msg.usage.output || 0 })),
    );
  }
}

export function errorBubble(message) {
  const { body } = makeBubble("assistant");
  body.appendChild(el("div", "prose error-text", String(message || "Unknown error")));
  scrollToBottom();
}

export function autogrow() {
  const ta = $("composer-input");
  if (!ta) return;
  ta.style.height = "auto";
  const view = (window.visualViewport && window.visualViewport.height) || window.innerHeight;
  ta.style.height = `${Math.min(ta.scrollHeight, Math.round(view * 0.4))}px`;
}

export async function send({ sessionId, mode, streaming, setStreamingFn }) {
  const ta = $("composer-input");
  if (!ta) return;
  const text = ta.value.trim();
  if (!text || streaming || !sessionId) return;
  makeBubble("user").body.appendChild(el("div", "prose", text));
  ta.value = "";
  autogrow();
  scrollToBottom(true);
  if (setStreamingFn) setStreamingFn(true);
  try {
    await api(`/api/sessions/${encodeURIComponent(sessionId)}/message`, {
      method: "POST",
      body: { text, mode },
    });
  } catch (err) {
    if (setStreamingFn) setStreamingFn(false);
    if (err.message !== "Unauthorized") errorBubble(err.message);
  }
}

export async function abort(sessionId) {
  if (!sessionId) return;
  try {
    await api(`/api/sessions/${encodeURIComponent(sessionId)}/abort`, { method: "POST" });
    setStatus(t("ui.stopping"));
  } catch (err) {
    fail(err);
  }
}

export function render(state) {
  // Render chat meta header and model chip
  const meta = $("chat-meta");
  if (meta && state && state.state) {
    const bits = [state.state.active, state.state.model].filter(Boolean).join(" \u00b7 ");
    meta.textContent = state.state.workspace ? `${bits} \u2014 ${state.state.workspace}` : bits;
  }
  const chipLabel = $("model-chip-label");
  if (chipLabel && state && state.state) {
    chipLabel.textContent = state.state.model || state.state.active || "model";
  }
  const warn = $("provider-warning");
  if (warn && state && state.state) {
    warn.hidden = Boolean(state.state.providerReady);
    warn.textContent = state.state.providerReady ? "" : t("chat.noKey");
  }
}

export function bindEvents({ onSend, onAbort, onToggleMode, onOpenSettings, onUndo, onRedo } = {}) {
  const m = messagesEl();
  if (m) {
    m.addEventListener("scroll", () => {
      const atBottom = m.scrollHeight - m.scrollTop - m.clientHeight < 80;
      stick = atBottom;
      const jump = $("jump-latest");
      if (jump) jump.hidden = atBottom;
    }, { passive: true });
  }
  const modelChip = $("model-chip");
  if (modelChip && onOpenSettings) {
    modelChip.addEventListener("click", onOpenSettings);
  }
  const settingsHeaderBtn = $("btn-settings-header");
  if (settingsHeaderBtn && onOpenSettings) {
    settingsHeaderBtn.addEventListener("click", onOpenSettings);
  }
  const jumpBtn = $("jump-latest");
  if (jumpBtn) jumpBtn.addEventListener("click", () => scrollToBottom(true));

  const ta = $("composer-input");
  let slashCommands = [];
  let selectedSlashIdx = -1;

  async function loadSlashCommands() {
    try {
      const res = await api("/api/slash-commands");
      if (res && res.commands) slashCommands = res.commands;
    } catch {
      // ignore
    }
  }

  const hintsEl = $("slash-hints");
  function hideSlashHints() {
    if (hintsEl) {
      hintsEl.hidden = true;
      hintsEl.textContent = "";
    }
    selectedSlashIdx = -1;
  }

  function renderSlashHints(matches) {
    if (!hintsEl) return;
    if (!matches.length) {
      hideSlashHints();
      return;
    }
    hintsEl.textContent = "";
    matches.forEach((c, idx) => {
      const item = el("div", `slash-item ${idx === selectedSlashIdx ? "selected" : ""}`);
      item.setAttribute("role", "option");
      item.setAttribute("data-cmd", c.name);

      const name = el("span", "slash-item-name", `/${c.name}`);
      const desc = el("span", "slash-item-desc", c.description || "");
      const badge = el("span", "slash-item-badge", c.kind || "builtin");

      item.appendChild(name);
      item.appendChild(desc);
      item.appendChild(badge);

      item.addEventListener("mousedown", (e) => {
        e.preventDefault();
        applySlash(c.name);
      });
      hintsEl.appendChild(item);
    });
    hintsEl.hidden = false;
  }

  function applySlash(cmdName) {
    if (!ta) return;
    ta.value = `/${cmdName} `;
    hideSlashHints();
    ta.focus();
    autogrow();
  }

  if (ta) {
    ta.addEventListener("input", async () => {
      autogrow();
      const val = ta.value;
      if (val.startsWith("/")) {
        if (!slashCommands.length) await loadSlashCommands();
        const match = val.match(/^\/([a-zA-Z0-9_-]*)$/);
        if (match) {
          const prefix = match[1].toLowerCase();
          const matches = slashCommands.filter((c) => c.name.toLowerCase().startsWith(prefix));
          selectedSlashIdx = 0;
          renderSlashHints(matches);
          return;
        }
      }
      hideSlashHints();
    });

    ta.addEventListener("keydown", (e) => {
      if (hintsEl && !hintsEl.hidden) {
        const items = hintsEl.querySelectorAll(".slash-item");
        if (e.key === "ArrowDown") {
          e.preventDefault();
          selectedSlashIdx = (selectedSlashIdx + 1) % items.length;
          items.forEach((it, idx) => it.classList.toggle("selected", idx === selectedSlashIdx));
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          selectedSlashIdx = (selectedSlashIdx - 1 + items.length) % items.length;
          items.forEach((it, idx) => it.classList.toggle("selected", idx === selectedSlashIdx));
          return;
        }
        if (e.key === "Enter" || e.key === "Tab") {
          if (items.length && selectedSlashIdx >= 0 && selectedSlashIdx < items.length) {
            e.preventDefault();
            const cmd = items[selectedSlashIdx].getAttribute("data-cmd");
            if (cmd) applySlash(cmd);
            return;
          }
        }
        if (e.key === "Escape") {
          e.preventDefault();
          hideSlashHints();
          return;
        }
      }

      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        hideSlashHints();
        if (onSend) onSend();
      }
    });
  }
  const composer = $("composer");
  if (composer && onSend) {
    composer.addEventListener("submit", (e) => {
      e.preventDefault();
      hideSlashHints();
      onSend();
    });
  }
  const stopBtn = $("btn-stop");
  if (stopBtn && onAbort) {
    stopBtn.addEventListener("click", onAbort);
  }
  const modeBtn = $("btn-mode");
  if (modeBtn && onToggleMode) {
    modeBtn.addEventListener("click", onToggleMode);
  }
  const undoBtn = $("btn-undo");
  if (undoBtn && onUndo) {
    undoBtn.addEventListener("click", onUndo);
  }
  const redoBtn = $("btn-redo");
  if (redoBtn && onRedo) {
    redoBtn.addEventListener("click", onRedo);
  }
}

export const Chat = {
  messagesEl,
  BUSY,
  getTurn,
  setTurn,
  getStick,
  setStick,
  scrollToBottom,
  messageHost,
  makeBubble,
  footerOf,
  ensureTurn,
  hostFor,
  reasoningBlock,
  scheduleRender,
  flushRender,
  clearDirtyBlocks,
  appendDelta,
  appendReasoning,
  noteLine,
  renderStoredMessage,
  errorBubble,
  autogrow,
  send,
  abort,
  render,
  bindEvents,
};

