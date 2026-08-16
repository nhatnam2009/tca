/**
 * Todo panel / checklist component.
 *
 * Rules:
 *   - in-place updates rather than appending to keep transcripts clean;
 *   - progress bar indicates percentage of done tasks.
 */

import { el, t } from "../helpers.js";

let todoCard = null;

export function renderTodo(items, hostEl) {
  if (!Array.isArray(items) || !items.length) {
    if (todoCard) todoCard.remove();
    todoCard = null;
    return null;
  }

  const done = items.filter((i) => i.status === "done").length;
  const card = el("section", "todo");
  card.setAttribute("role", "group");
  card.setAttribute("aria-label", t("todo.title"));

  const head = el("div", "todo-head");
  head.append(
    el("p", "todo-title", t("todo.title")),
    el("p", "todo-count", t("todo.progress", { done, total: items.length })),
  );
  card.appendChild(head);

  const bar = el("div", "todo-bar");
  bar.setAttribute("role", "img");
  bar.setAttribute("aria-label", t("todo.progress", { done, total: items.length }));
  const fill = el("span", "todo-bar-fill");
  fill.style.width = `${items.length ? Math.round((done / items.length) * 100) : 0}%`;
  bar.appendChild(fill);
  card.appendChild(bar);

  const list = el("ul", "todo-list");
  for (const item of items) {
    const status = ["pending", "in_progress", "done"].includes(item.status) ? item.status : "pending";
    const li = document.createElement("li");
    li.className = `todo-item ${status}`;
    const glyph = status === "done" ? "\u2713" : status === "in_progress" ? "\u203a" : "\u25cb";
    const mark = el("span", "todo-mark", glyph);
    mark.setAttribute("role", "img");
    mark.setAttribute("aria-label", t(`todo.status.${status}`));
    li.append(mark, el("span", "todo-text", String(item.text || "")));
    list.appendChild(li);
  }
  card.appendChild(list);

  if (todoCard && todoCard.parentElement) todoCard.replaceWith(card);
  else if (hostEl) hostEl.appendChild(card);
  todoCard = card;
  return card;
}

export function resetTodo() {
  if (todoCard) todoCard.remove();
  todoCard = null;
}

export function render(state, hostEl) {
  if (state && state.todoItems) {
    renderTodo(state.todoItems, hostEl);
  }
}

export function bindEvents() {}

export const TodoPanel = {
  renderTodo,
  resetTodo,
  render,
  bindEvents,
};

