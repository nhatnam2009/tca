/**
 * Status bar & context meter component.
 *
 * Rules:
 *   - context meter updates in real time with tokens & cost;
 *   - stream status and activity spinner toggle on streaming.
 */

import { $, fmtTokens, t } from "../helpers.js";

export function setStatus(text) {
  const elStatus = $("stream-status");
  if (elStatus) elStatus.textContent = text || "";
}

export function setStreaming(on, BUSY) {
  const btnSend = $("btn-send");
  const btnStop = $("btn-stop");
  const act = $("activity");
  const dot = $("status-dot");
  if (btnSend) btnSend.disabled = on;
  if (btnStop) btnStop.hidden = !on;
  if (act) act.hidden = !on;
  if (dot) {
    dot.className = on ? "live-dot busy" : "live-dot online";
    dot.setAttribute("aria-label", on ? "Status: Working" : "Status: Ready");
    dot.title = on ? "Working" : "Ready";
  }
  setStatus(on ? (typeof BUSY === "function" ? BUSY() : BUSY || t("chat.working")) : "");
}

export function renderMeter(state) {
  const bar = $("ctx-fill");
  const label = $("ctx-label");
  if (!bar || !label) return;
  const win = (state && state.meter && state.meter.window) || (state && state.state && state.state.contextWindow) || 0;
  const used = (state && state.meter && state.meter.used) || 0;
  const spent = (state && state.spent) || { cost: 0, cacheRead: 0 };
  const pct = win ? Math.min(100, Math.round((used / win) * 100)) : 0;
  bar.style.width = `${pct}%`;
  if (bar.parentElement) bar.parentElement.classList.toggle("hot", pct >= 75);
  const parts = [];
  if (win) parts.push(t("meter.context", { pct, used: fmtTokens(used), window: fmtTokens(win) }));
  if (spent.cacheRead) parts.push(t("meter.cached", { n: fmtTokens(spent.cacheRead) }));
  if (spent.cost) parts.push(`$${spent.cost < 0.01 ? spent.cost.toFixed(4) : spent.cost.toFixed(3)}`);
  label.textContent = parts.join("  \u00b7  ");
}

export function resetMeter(state) {
  if (state) {
    state.spent = { cost: 0, input: 0, output: 0, cacheRead: 0 };
    state.meter = { used: 0, window: (state.state && state.state.contextWindow) || 0 };
  }
  renderMeter(state);
}

export function render(state) {
  renderMeter(state);
}

export function bindEvents() {}

export const StatusBar = {
  setStatus,
  setStreaming,
  renderMeter,
  resetMeter,
  render,
  bindEvents,
};

