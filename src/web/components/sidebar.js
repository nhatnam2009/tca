/**
 * Sidebar / sessions management component.
 *
 * Rules:
 *   - displays session titles and message counts;
 *   - handles new session and delete session actions safely.
 */

import { $, el, option, t } from "../helpers.js";

export function sessionLabel(s) {
  const title = (s.title || "").trim() || t("chat.sessionFallback", { id: String(s.id).slice(0, 8) });
  return s.messageCount ? `${title} (${s.messageCount})` : title;
}

export function fillSessionSelect(state) {
  const sel = $("session-select");
  if (!sel) return;
  sel.textContent = "";
  const sessions = (state && state.sessions) || [];
  for (const s of sessions) sel.appendChild(option(s.id, sessionLabel(s)));
  if (state && state.sessionId) sel.value = state.sessionId;
  const delBtn = $("btn-delete-session");
  if (delBtn) delBtn.disabled = !state || !state.sessionId;
}

export function render(state) {
  fillSessionSelect(state);
}

export function bindEvents({ onSelectSession, onNewSession, onDeleteSession }) {
  const sel = $("session-select");
  if (sel && onSelectSession) {
    sel.addEventListener("change", (e) => onSelectSession(e.target.value));
  }
  const newBtn = $("btn-new-session");
  if (newBtn && onNewSession) {
    newBtn.addEventListener("click", () => onNewSession());
  }
  const delBtn = $("btn-delete-session");
  if (delBtn && onDeleteSession) {
    delBtn.addEventListener("click", () => onDeleteSession());
  }
}

export const Sidebar = {
  sessionLabel,
  fillSessionSelect,
  render,
  bindEvents,
};

