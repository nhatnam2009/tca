/**
 * Context management: token estimation, history repair, and real compaction.
 *
 * This replaces an earlier `compactHistory` in loop.js that sliced the middle out
 * of the message list by *message count* and replaced it with `String(content).
 * slice(0, 200)`. It had two fatal problems, and both are the reason this file
 * exists rather than a patch to that one:
 *
 *   1. It split tool_use from tool_result. Keeping messages[0..2] and the last 6
 *      leaves an assistant tool_use whose tool_result was in the summarised
 *      middle, and a tool_result whose tool_use is gone. Anthropic rejects that
 *      request with a 400, so every session past 30 messages died. The fake
 *      provider in the tests does not validate pairing, so nothing caught it.
 *   2. Truncating each message to 200 chars threw away every tool result. The
 *      agent kept the knowledge that it had read five files and lost their
 *      contents, which is a worse state than not having read them: it stops
 *      re-reading because it believes it already knows.
 *
 * What happens instead:
 *   - Cuts are only made at *turn boundaries* (a `user` message), so a prefix can
 *     never contain half of a tool exchange.
 *   - The dropped prefix is summarised by the model, not by slice(). The summary
 *     is persisted as a checkpoint so it is produced once, not on every turn.
 *   - The trigger is estimated tokens against the model's real context window,
 *     not a message count.
 */

import { stream } from "./provider.js";

/** Fraction of the context window at which we compact. */
export const COMPACT_AT = 0.75;
/** Never summarise so much that the model loses the thread of what it is doing. */
const KEEP_TAIL_TOKENS_FRACTION = 0.25;
/** Below this there is nothing worth summarising. */
const MIN_MESSAGES_TO_COMPACT = 8;

/**
 * Rough token count for one neutral message.
 *
 * Deliberately an estimate. A real tokenizer is a megabyte of tables per model
 * family, this runs on a phone, and the only decision it feeds is "compact now
 * or later" - being 15% out moves that decision by one turn. ~3.6 chars/token is
 * a little more pessimistic than English prose because code and JSON tokenize
 * worse than prose does.
 * @param {any} m
 */
function messageTokens(m) {
  let chars = 0;
  if (typeof m?.content === "string") chars += m.content.length;
  if (typeof m?.reasoning === "string") chars += m.reasoning.length;
  for (const c of m?.toolCalls || []) {
    chars += (c.name || "").length;
    chars += JSON.stringify(c.input ?? {}).length;
  }
  for (const r of m?.results || []) {
    chars += (r.output || "").length + (r.name || "").length;
  }
  return Math.ceil(chars / 3.6) + 8; // +8 for per-message role/framing overhead
}

/**
 * Estimated prompt size of a whole history.
 * @param {any[]} messages
 */
export function estimateTokens(messages) {
  let total = 0;
  for (const m of messages) total += messageTokens(m);
  return total;
}

/**
 * Every index at which the history can be cut without orphaning a tool call.
 *
 * A cut at `i` is safe exactly when no tool_use is still waiting for its result
 * at that point - then everything before `i` is self-contained and everything
 * from `i` on stands on its own.
 *
 * That is a wider set than "every user message", and deliberately so: a single
 * turn can overflow the context window all by itself (forty steps, each reading a
 * file), and if the only legal cuts were turn starts there would be nothing to do
 * about it but send an over-budget prompt and watch it fail.
 *
 * Index 0 is excluded because cutting there removes nothing, and the end is
 * excluded because cutting there removes everything.
 * @param {any[]} messages
 * @returns {number[]}
 */
export function turnBoundaries(messages) {
  /** @type {number[]} */
  const out = [];
  /** @type {Set<string>} */
  const open = new Set();
  for (let i = 0; i < messages.length; i++) {
    if (i > 0 && !open.size) out.push(i);
    const m = messages[i];
    if (m?.role === "assistant") for (const c of m.toolCalls || []) open.add(c.id);
    else if (m?.role === "tool") for (const r of m.results || []) open.delete(r.id);
  }
  return out;
}

/**
 * Report every tool_use without a tool_result and vice versa.
 *
 * Both providers reject such a request, so this is the invariant that has to hold
 * for anything we send. Exported because it is what the tests assert, and because
 * a named check is how this class of bug stops being invisible.
 * @param {any[]} messages
 * @returns {string[]} empty when the history is valid
 */
export function pairingErrors(messages) {
  /** @type {Map<string, number>} */
  const open = new Map();
  /** @type {string[]} */
  const errors = [];
  for (const [i, m] of messages.entries()) {
    if (m?.role === "assistant") {
      for (const c of m.toolCalls || []) open.set(c.id, i);
    } else if (m?.role === "tool") {
      for (const r of m.results || []) {
        if (!open.has(r.id)) errors.push(`message ${i}: tool_result "${r.id}" has no matching tool_use`);
        else open.delete(r.id);
      }
    }
  }
  for (const [id, i] of open) errors.push(`message ${i}: tool_use "${id}" has no matching tool_result`);
  return errors;
}

/**
 * Make a history sendable, whatever state it was left in.
 *
 * A turn that was killed mid-flight - the process being OOM-killed on a phone is
 * the normal case, not the exotic one - leaves an assistant message whose tool
 * results were never appended. Rather than refuse to continue the session, give
 * those calls a synthetic "interrupted" result: that is true, the model handles
 * it fine, and it keeps the assistant's text instead of dropping the message.
 *
 * Orphaned results in the other direction are dropped, since a result whose call
 * is unknown is not information the model can use.
 * @param {any[]} messages
 * @returns {any[]}
 */
export function repairHistory(messages) {
  /** @type {any[]} */
  const out = [];
  /** @type {Set<string>} */
  const open = new Set();

  /** Synthetic results for whatever is still waiting, as one message. */
  const stubs = () =>
    [...open].map((id) => ({
      id,
      name: "unknown",
      output: "[interrupted: this tool never ran, the turn was cut short]",
      ok: false,
    }));

  const settle = () => {
    if (!open.size) return;
    out.push({ role: "tool", results: stubs() });
    open.clear();
  };

  for (const m of messages) {
    if (m?.role === "assistant") {
      settle(); // an assistant message can never answer a previous one's calls
      out.push(m);
      for (const c of m.toolCalls || []) open.add(c.id);
    } else if (m?.role === "tool") {
      const kept = (m.results || []).filter((r) => open.has(r.id));
      for (const r of kept) open.delete(r.id);
      // One tool message, not two. Two in a row would both map to the user role
      // on the Anthropic wire and break its strict role alternation.
      const results = [...kept, ...stubs()];
      open.clear();
      if (results.length) out.push({ ...m, results });
    } else {
      settle();
      out.push(m);
    }
  }
  settle();
  return out;
}

const SUMMARY_INSTRUCTIONS = `You are compacting the transcript of a coding session so it can continue in a smaller context window.

Write a summary that lets you resume the work without re-reading anything. Optimise for being able to act, not for being readable. Use these sections and omit any that would be empty:

## Goal
What the user asked for, in their own terms. Include any constraint they stated.

## What is known about the codebase
Concrete facts discovered by reading files: paths, function and type names, signatures, where things live, how the build and tests are run. Keep exact identifiers and exact paths - a summary that says "the config module" instead of "src/config.js:61 configPath()" is useless.

## Changes already made
Every file created, edited or deleted, and what the change was. Note whether it was verified.

## Decisions and constraints
Choices made and why, and anything ruled out. This prevents re-litigating settled questions.

## Failures
What was tried and did not work, with the error. This is the most valuable section: without it the same dead end gets walked into again.

## Current state and next step
Exactly where the work stopped and what to do next.

Be specific and dense. Do not add commentary about the summary itself.`;

/**
 * Summarise a slice of history with the model.
 *
 * Uses the same provider as the session, with no tools: this is a pure
 * text task, and offering tools here invites the model to start working again
 * instead of summarising.
 *
 * @param {object} args
 * @param {import("./config.js").ProviderConfig} args.provider
 * @param {any[]} args.messages          the prefix being dropped
 * @param {string} [args.previousSummary] summary this one supersedes, if any
 * @param {AbortSignal} [args.signal]
 * @returns {Promise<string>}
 */
export async function summarize({ provider, messages, previousSummary, signal }) {
  const transcript = renderTranscript(messages);
  const ask = [
    previousSummary ? `Summary of the session up to this point:\n\n${previousSummary}\n\n---\n` : "",
    "Transcript to fold into a single updated summary:\n\n",
    transcript,
  ].join("");

  let text = "";
  for await (const ev of stream({
    provider,
    system: SUMMARY_INSTRUCTIONS,
    messages: [{ role: "user", content: ask }],
    tools: [],
    signal,
  })) {
    if (ev.type === "text") text += ev.text;
  }
  return text.trim();
}

/**
 * Flatten neutral messages into text for the summariser.
 *
 * Tool results are kept but clipped: the point of a summary is that the model
 * extracts what mattered from a 40 KB file dump, and it needs to see enough of
 * the dump to do that without the summarisation request itself overflowing.
 * @param {any[]} messages
 */
function renderTranscript(messages) {
  const PER_RESULT = 4_000;
  /** @type {string[]} */
  const out = [];
  for (const m of messages) {
    if (m.role === "user") {
      out.push(`USER: ${m.content || ""}`);
    } else if (m.role === "assistant") {
      if (m.content) out.push(`ASSISTANT: ${m.content}`);
      for (const c of m.toolCalls || []) {
        out.push(`ASSISTANT CALLS ${c.name}(${clip(JSON.stringify(c.input ?? {}), 600)})`);
      }
    } else if (m.role === "tool") {
      for (const r of m.results || []) {
        out.push(`RESULT ${r.name} ${r.ok ? "ok" : "FAILED"}: ${clip(r.output || "", PER_RESULT)}`);
      }
    }
  }
  return out.join("\n\n");
}

function clip(s, n) {
  return s.length <= n ? s : `${s.slice(0, n)} [... ${s.length - n} more chars ...]`;
}

/**
 * Decide whether to compact, and where to cut.
 *
 * Returns the cut index: messages[0..cut) get summarised, messages[cut..] are
 * kept verbatim. `0` means no compaction is needed or none is possible.
 *
 * The cut is the *latest* turn boundary that still leaves the tail under its
 * budget, so as little as possible is summarised away. If no boundary qualifies -
 * one enormous turn - the last boundary is used anyway, because sending an
 * over-budget prompt is a hard failure while an over-budget tail is only slow.
 *
 * @param {any[]} messages
 * @param {number} contextWindow
 * @returns {{cut: number, tokens: number, limit: number}}
 */
export function planCompaction(messages, contextWindow) {
  const tokens = estimateTokens(messages);
  const limit = Math.floor(contextWindow * COMPACT_AT);
  if (tokens <= limit || messages.length < MIN_MESSAGES_TO_COMPACT) {
    return { cut: 0, tokens, limit };
  }

  const boundaries = turnBoundaries(messages);
  if (!boundaries.length) return { cut: 0, tokens, limit };

  const tailBudget = Math.floor(contextWindow * KEEP_TAIL_TOKENS_FRACTION);
  // Walk from the end so the first boundary that fits is the latest one.
  let best = 0;
  for (let i = boundaries.length - 1; i >= 0; i--) {
    const tail = estimateTokens(messages.slice(boundaries[i]));
    if (tail <= tailBudget) {
      best = boundaries[i];
      break;
    }
  }
  if (!best) best = boundaries[boundaries.length - 1];
  return { cut: best, tokens, limit };
}
