/**
 * Inline approval card component (Allow / Deny).
 *
 * Rules:
 *   - prominent prompt for commands and edits requiring confirmation;
 *   - freezes upon decision or timeout.
 */

import { el, t, toast, fail } from "../helpers.js";
import { pre } from "../markdown.js";
import { api } from "../api.js";

export const approvals = new Map();

export function approvalCard(ev, { messageHost, scrollToBottom }) {
  const isEdit = ev.kind === "edit";
  const card = el("section", "approval");
  card.setAttribute("role", "group");
  card.setAttribute("aria-label", isEdit ? t("approval.edit.aria") : t("approval.command.aria"));
  card.tabIndex = -1;
  card.append(
    el("p", "approval-title", isEdit ? t("approval.edit.title") : t("approval.command.title")),
    pre(ev.command ?? ""),
  );
  if (ev.reason) card.appendChild(el("p", "small", String(ev.reason)));
  if (ev.cwd) card.appendChild(el("p", "muted small", t(isEdit ? "approval.workspace" : "approval.cwd", { path: ev.cwd })));

  const allow = el("button", "btn primary grow", t("approval.allow"));
  const deny = el("button", "btn danger grow", t("approval.deny"));
  allow.type = deny.type = "button";
  const row = el("div", "row");
  const result = el("p", "approval-result");
  result.hidden = true;

  const settle = (label) => {
    allow.disabled = deny.disabled = true;
    card.classList.add("resolved");
    result.textContent = label;
    result.hidden = false;
    row.hidden = true;
    approvals.delete(String(ev.id));
  };

  const decide = async (approved) => {
    allow.disabled = deny.disabled = true;
    try {
      await api(`/api/approvals/${encodeURIComponent(ev.id)}`, { method: "POST", body: { approved } });
      settle(approved ? t("approval.allowed") : t("approval.denied"));
    } catch (err) {
      allow.disabled = deny.disabled = false;
      fail(err);
    }
  };
  allow.addEventListener("click", () => decide(true));
  deny.addEventListener("click", () => decide(false));

  row.append(allow, deny);
  card.append(row, result);
  if (typeof messageHost === "function") messageHost().appendChild(card);
  approvals.set(String(ev.id), settle);
  if (typeof scrollToBottom === "function") scrollToBottom();

  toast(isEdit ? t("approval.toast.edit") : t("approval.toast.command"), "warn");
  try { card.focus({ preventScroll: true }); } catch { card.focus(); }
  return card;
}

export function closeApproval(id, outcome) {
  const settle = approvals.get(String(id));
  if (settle) settle(outcome === "timeout" ? t("approval.timedOut") : t("approval.cancelled"));
}

export function render() {}

export function bindEvents() {}

export const Approval = {
  approvals,
  approvalCard,
  closeApproval,
  render,
  bindEvents,
};

