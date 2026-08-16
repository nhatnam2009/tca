/**
 * Tool call & Subagent card component.
 *
 * Rules:
 *   - collapsed details/summary by default;
 *   - diff output is automatically opened on success;
 *   - subagents render in nested collapsible blocks.
 */

import { el, t } from "../helpers.js";
import { pre, outputBlock, looksLikeDiff } from "../markdown.js";

/** One-line summary of a tool's input object, for the collapsed row. */
export function shortInput(input) {
  if (input == null) return "";
  if (typeof input === "string") return input;
  for (const k of ["command", "cmd", "path", "file", "pattern", "query", "url"]) {
    if (typeof input[k] === "string" && input[k]) return input[k];
  }
  try { return JSON.stringify(input); } catch { return ""; }
}

export function prettyInput(input) {
  if (typeof input === "string") return input;
  try { return JSON.stringify(input, null, 2); } catch { return String(input); }
}

/**
 * Collapsed tool row - `> run_command  npm test`.
 */
export function toolRow(container, name, input) {
  const badge = el("span", "tool-state", "\u2026");
  const sum = el("summary");
  sum.append(
    el("span", "tool-caret", "\u203a"),
    el("span", "tool-name", name || "tool"),
    el("span", "tool-arg", shortInput(input).slice(0, 160)),
    badge,
  );
  const body = el("div", "tool-body");
  body.append(el("p", "tool-label", t("tool.input")), pre(prettyInput(input)));
  const row = el("details", "tool");
  row.append(sum, body);
  container.appendChild(row);
  return { row, badge, body };
}

export function finishToolRow(handle, ok, output) {
  handle.badge.textContent = ok ? t("tool.ok") : t("tool.error");
  handle.badge.classList.add(ok ? "ok" : "bad");
  if (!ok) handle.row.classList.add("bad");
  handle.body.append(el("p", "tool-label", t("tool.output")), outputBlock(output));
  if (ok && looksLikeDiff(output)) handle.row.open = true;
}

export function subagentBlock(ev, ensureTurnFn, scrollToBottomFn) {
  const cur = ensureTurnFn();
  const id = String(ev.id);
  if (cur.subs.has(id)) return cur.subs.get(id);
  const badge = el("span", "tool-state", "\u2026");
  const sum = el("summary");
  sum.append(
    el("span", "tool-caret", "\u203a"),
    el("span", "tool-name", t("sub.title")),
    el("span", "tool-arg", ev.kind === "general" ? t("sub.kind.general") : t("sub.kind.explore")),
    badge,
  );
  const body = el("div", "tool-body");
  const block = el("details", "subagent");
  block.open = true;
  block.append(sum, body);
  cur.body.appendChild(block);
  cur.text = null;
  const handle = { block, badge, body, tools: new Map() };
  cur.subs.set(id, handle);
  if (typeof scrollToBottomFn === "function") scrollToBottomFn();
  return handle;
}

export function render() {}

export function bindEvents() {}

export const ToolCard = {
  shortInput,
  prettyInput,
  toolRow,
  finishToolRow,
  subagentBlock,
  render,
  bindEvents,
};

