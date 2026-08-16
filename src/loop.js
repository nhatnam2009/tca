/**
 * The agent loop: user text -> model -> tools -> model -> ... -> answer.
 *
 * One Agent owns one in-flight turn. The root agent persists to a session file
 * and is what the UI talks to; sub-agents spawned by the `task` tool are the same
 * class with an in-memory history and a narrower tool set, which is what lets a
 * twenty-file investigation cost the parent one paragraph instead of twenty file
 * dumps.
 *
 * Context is managed by summarising at turn boundaries (see compact.js), never by
 * slicing the message list - slicing splits tool_use from tool_result and both
 * providers reject that outright.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { stream, ProviderError } from "./provider.js";
import { callTool, toolSpecs, pickShell } from "./tools.js";
import { appendMessage, appendCheckpoint, agentHistory, maybeSetTitle, readTodos, SUMMARY_MARKER } from "./store.js";
import { modelsFor } from "./catalog.js";
import { clearNotification, notify, vibrate } from "./notify.js";
import { planCompaction, summarize, repairHistory, estimateTokens, pairingErrors } from "./compact.js";

const APPROVAL_TIMEOUT = 10 * 60_000;
const FALLBACK_CONTEXT_WINDOW = 128_000; // used only when the catalog has no entry for this model
/** Project conventions, read fresh every turn so editing the file takes effect. */
const AGENTS_FILE = "AGENTS.md";
const AGENTS_MAX = 8_000;
/**
 * How many identical tool batches in a row count as being stuck.
 *
 * There is deliberately no step budget. A cap has to be either low enough to cut
 * off real work or high enough to be no protection, and picking the number is
 * guessing on the user's behalf about a task only they can see. What replaced it
 * detects the actual failure instead: the same calls, the same arguments, the same
 * results, over and over. That is never progress, and it is the shape a runaway
 * loop actually has. Anything genuinely working changes its arguments.
 *
 * Three, because two can legitimately happen - re-reading a file after an edit
 * that turned out to be a no-op, say.
 */
const NO_PROGRESS_REPEATS = 3;

/**
 * One short, comparable string for "what happened this step".
 *
 * Hashed rather than kept whole because a step's output can be a megabyte of
 * file contents, and three of those held live for the whole run - on a phone -
 * is a real cost for a comparison that only ever asks "the same as last time?".
 *
 * Tool calls are sorted first: the model can emit a parallel batch in any order
 * and it is the same batch. Ids are left out for the same reason - they are fresh
 * every step by design, so including them would make every step unique and the
 * check would never fire.
 *
 * @param {Array<{name: string, input: any}>} toolCalls
 * @param {Array<{name: string, output: string, ok: boolean}>} results
 */
function hashStep(toolCalls, results) {
  const calls = toolCalls
    .map((c) => JSON.stringify([c.name, c.input]))
    .sort()
    .join("\n");
  const out = results
    .map((r) => JSON.stringify([r.name, r.ok, r.output]))
    .sort()
    .join("\n");
  return createHash("sha1").update(`${calls}\n--\n${out}`).digest("hex");
}

/**
 * Project-specific instructions, if the workspace has an AGENTS.md.
 *
 * This is the cheapest way for the agent to learn "this project uses tabs", "run
 * pnpm not npm", "never touch generated/". Read on every turn rather than cached,
 * so the user can edit the file and see the effect on the next message.
 * @param {string} workspace
 */
function projectInstructions(workspace) {
  try {
    const file = path.join(workspace, AGENTS_FILE);
    const stat = fs.statSync(file, { throwIfNoEntry: false });
    if (!stat || !stat.isFile()) return "";
    const text = fs.readFileSync(file, "utf8").trim();
    if (!text) return "";
    return text.length > AGENTS_MAX ? `${text.slice(0, AGENTS_MAX)}\n[... truncated ...]` : text;
  } catch {
    return "";
  }
}

/**
 * The real context window (total tokens a model can see), looked up from the
 * catalog by model id. NOT the same number as provider.maxTokens, which is
 * the max *output* tokens requested per turn (often 4k-8k) - conflating the
 * two used to make the "context usage high" warning fire on almost every
 * message, since 80% of an 8k output cap is only ~6.5k input tokens.
 * @param {import("./config.js").Config} config
 * @param {import("./config.js").ProviderConfig} provider
 */
function catalogEntry(config, provider) {
  return modelsFor(config.active).find((m) => m.id === provider.model) || null;
}

/**
 * USD for one turn, from the catalog's per-million prices.
 *
 * Cached reads are billed at a tenth of the input rate on Anthropic, which is the
 * whole point of prompt caching, so they are counted separately rather than
 * folded into input - otherwise the number would say caching saved nothing.
 * @param {ReturnType<typeof catalogEntry>} model
 * @param {{input: number, output: number, cacheRead?: number, cacheWrite?: number}} usage
 */
function costOf(model, usage) {
  if (!model || model.input_cost == null || model.output_cost == null) return null;
  const M = 1_000_000;
  const fresh = Math.max(0, usage.input - (usage.cacheRead || 0));
  return (
    (fresh * model.input_cost) / M +
    ((usage.cacheRead || 0) * model.input_cost * 0.1) / M +
    ((usage.cacheWrite || 0) * model.input_cost * 1.25) / M +
    (usage.output * model.output_cost) / M
  );
}

/**
 * The system prompt.
 *
 * Written for a model that is about to act, not for a human reading docs. Every
 * line is either a fact it cannot discover on its own or a behaviour that has
 * actually gone wrong without being said explicitly.
 *
 * @param {object} args
 * @param {import("./config.js").Config} args.config
 * @param {string} args.workspace
 * @param {Array<{text: string, status: string}>} [args.todos]
 * @param {"build"|"plan"} [args.mode]
 * @param {"root"|"explore"|"general"} [args.kind]
 */
export function buildSystemPrompt({ config, workspace, todos = [], mode = "build", kind = "root" }) {
  const shell = pickShell().shell;
  const termux = Boolean(process.env.TERMUX_VERSION);
  const projectNotes = projectInstructions(workspace);
  const openPlan =
    todos.length && todos.some((x) => x.status !== "done")
      ? todos
          .map((x) => `[${x.status === "done" ? "x" : x.status === "in_progress" ? ">" : " "}] ${x.text}`)
          .join("\n")
      : "";

  if (kind === "explore" || kind === "general") {
    return [
      kind === "explore"
        ? "You are a research sub-agent. You investigate and report; you do not change anything."
        : "You are a sub-agent carrying out one delegated piece of work.",
      "",
      "Environment:",
      `- Workspace root: ${workspace}. Every path is relative to it and you cannot escape it.`,
      `- Platform: ${os.platform()} ${os.arch()}${termux ? " (Termux on Android)" : ""}`,
      `- Shell: ${shell}`,
      "",
      "How to work:",
      "- Search widely before concluding. Try more than one name for the same idea; codebases are inconsistent.",
      "- Read the files you cite. Never report a path, signature or line number you have not seen.",
      "- You are talking to another agent, not a person. No preamble, no offers of further help.",
      "",
      "Your reply is the only thing that survives - everything you read is discarded. So it must be self-contained:",
      "- Answer the question that was asked, first, in one or two sentences.",
      "- Then the evidence: exact `path:line` references and the identifiers that matter.",
      "- Then anything you looked for and could not find, which is information too.",
      projectNotes ? `\nProject instructions (from ${AGENTS_FILE}):\n${projectNotes}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  }

  const planning = mode === "plan";
  return [
    "You are a coding agent operating directly on the user's machine through tools.",
    "",
    "Environment:",
    `- Workspace root: ${workspace} (every path you pass to a tool is relative to this, and you cannot escape it)`,
    `- Platform: ${os.platform()} ${os.arch()}${termux ? ` (Termux on Android, ${process.env.TERMUX_VERSION})` : ""}`,
    `- Shell: ${shell}`,
    termux
      ? "- This is a phone. Builds and test suites are slow, battery and heat are real constraints, and there is no sudo. Prefer targeted commands over whole-repo operations."
      : "",
    "",
    planning
      ? [
          "MODE: plan. You are read-only right now. Every file-writing tool has been withheld, and shell commands need explicit approval each time.",
          "Investigate the codebase properly, then set out what you would change: which files, what edits, in what order, and what could go wrong.",
          "Do not write the change as a code block pretending to be a plan. Say where it goes and why. The user switches to build mode when they want it applied.",
        ].join("\n")
      : [
          "MODE: build. You may read, write and run commands.",
        ].join("\n"),
    "",
    "How to work:",
    "- Read before you write. Never guess a file's contents or a function's signature; open it.",
    "- Prefer edit_file over write_file for existing files, so you do not destroy code you have not read.",
    "- Use the dedicated tools for files and search. Reach for run_command only for things that genuinely need a shell: git, tests, builds, package managers.",
    "- Delegate wide reading to `task`. If answering something means opening more than about five files, send a sub-agent instead: its reading does not enter your context, only its answer does.",
    "- Independent tool calls go in one message so they run together. Only sequence them when one genuinely needs another's result.",
    "- Writes are checked automatically with the project's own checker, and the result comes back attached to the edit. Read it. If it reports an error, that error is in the code you just wrote; fix it before moving on.",
    "- After changing code, run the project's build or tests if they exist. Report what you actually ran, not what you assume works.",
    "- Work in small verified steps. If the same approach fails twice, stop and diagnose the cause instead of retrying variations.",
    "- If a tool returns an error, read it and adapt. Tool errors are information, not a reason to stop.",
    "- Use todo_write for anything past a couple of steps, and keep it current. It is re-shown to you every turn, so it is what survives when the conversation is compacted.",
    "",
    "Style:",
    "- Answers are read on a phone screen. Be brief. Lead with the result.",
    "- No preamble like 'Let me...' or 'I will now...'. Just act, then report.",
    "- Reference code as `path:line` so the user can jump to it.",
    "- Use Markdown: fenced code blocks with a language tag, backticks for identifiers and paths.",
    "- Say plainly when something did not work or you could not verify it. Do not describe an unverified change as done.",
    config.instructions ? `\nUser instructions:\n${config.instructions}` : "",
    projectNotes
      ? `\nProject instructions (from ${AGENTS_FILE} in the workspace, these take precedence):\n${projectNotes}`
      : "",
    openPlan ? `\nYour plan for this task so far (keep it current with todo_write):\n${openPlan}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * In-memory history, for sub-agents.
 *
 * A delegated investigation is scratch work: it is worth showing live and worth
 * nothing afterwards, so it never touches the session file. On a phone that also
 * keeps the transcript from tripling in size for a task the user only sees the
 * conclusion of.
 */
class MemoryHistory {
  constructor() {
    /** @type {any[]} */
    this.messages = [];
    this.summary = "";
    this.headLen = 0;
  }
  get() {
    if (!this.summary) {
      this.headLen = 0;
      return this.messages;
    }
    const head = [{ role: "user", content: `${SUMMARY_MARKER}\n\n${this.summary}` }];
    if (this.messages[0]?.role !== "assistant") {
      head.push({ role: "assistant", content: "Understood. Continuing." });
    }
    this.headLen = head.length;
    return [...head, ...this.messages];
  }
  /** @param {any} m */
  async append(m) {
    this.messages.push(m);
  }
  /** @param {string} summary @param {number} through */
  async checkpoint(summary, through) {
    const drop = this.headLen ? Math.max(0, through - this.headLen) : through;
    this.messages = this.messages.slice(drop);
    this.summary = summary;
  }
}

/** The session file, for the root agent. */
class SessionHistory {
  /** @param {string} id */
  constructor(id) {
    this.id = id;
  }
  get() {
    return agentHistory(this.id).messages;
  }
  /** @param {any} m */
  async append(m) {
    await appendMessage(this.id, m);
  }
  /** @param {string} summary @param {number} through */
  async checkpoint(summary, through) {
    // `through` counts into the array agentHistory() returned, which already had
    // the previous summary spliced in as one or two messages. Convert back to a
    // raw file index so the stored checkpoint means the same thing next time.
    const { dropped, head } = agentHistory(this.id);
    const raw = head ? dropped + Math.max(0, through - head) : through;
    await appendCheckpoint(this.id, summary, raw);
  }
}

/**
 * What a sub-agent is allowed to say to the UI.
 *
 * An allowlist rather than a filter on the noisy ones, because the event that has
 * to be kept out is `done`. A sub-agent finishing emitted a bare `done`, the UI
 * treated it as the end of the whole turn - closed the message, stopped the
 * spinner, dropped the streaming state - and then the parent kept talking into a
 * transcript that had already been sealed off. `subagent_end` reports the same
 * fact without that side effect.
 *
 * Its usage is folded into the parent's spend, so `usage` is redundant too; step
 * counters and titles belong to the root turn alone.
 */
const SUBAGENT_EVENTS = new Set([
  "tool_start",
  "tool_end",
  "tool_note",
  "text_delta",
  "approval_request",
  "approval_closed",
]);

export class Agent {
  /**
   * @param {object} args
   * @param {import("./config.js").Config} args.config
   * @param {(event: any) => void} args.emit
   * @param {string} [args.sessionId]                      required for the root agent
   * @param {"root"|"explore"|"general"} [args.kind]
   * @param {AbortSignal} [args.parentSignal]
   * @param {string} [args.idPrefix]                       keeps nested ids unique
   */
  constructor({ config, emit, sessionId, kind = "root", parentSignal, idPrefix = "" }) {
    this.config = config;
    this.emit = emit;
    this.sessionId = sessionId;
    this.kind = kind;
    this.mode = /** @type {"build"|"plan"} */ (config.mode === "plan" ? "plan" : "build");
    this.controller = new AbortController();
    if (parentSignal) {
      if (parentSignal.aborted) this.controller.abort();
      else parentSignal.addEventListener("abort", () => this.controller.abort(), { once: true });
    }
    this.history = kind === "root" ? new SessionHistory(sessionId) : new MemoryHistory();
    this.idPrefix = idPrefix;
    /** @type {Map<string, (ok: boolean) => void>} */
    this.pending = new Map();
    this.running = false;
    this.seq = 0;
    this.subSeq = 0;
    /** Accumulated over the whole turn, including sub-agents. */
    this.spend = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  }

  abort() {
    for (const [id, resolve] of this.pending) {
      // Tell the UI the card is dead, otherwise it sits there looking clickable.
      this.emit({ type: "approval_closed", id, outcome: "aborted" });
      resolve(false);
    }
    this.pending.clear();
    this.controller.abort();
  }

  /**
   * The system prompt for this turn.
   *
   * A method rather than a bare call so it can be inspected on its own: the parts
   * that come from outside the code - AGENTS.md in the workspace, the saved plan -
   * are exactly the parts worth having a test for.
   */
  buildSystemPrompt() {
    return buildSystemPrompt({
      config: this.config,
      workspace: this.config.workspace,
      todos: this.sessionId ? readTodos(this.sessionId) : [],
      mode: this.mode,
      kind: this.kind,
    });
  }

  /** @param {string} id @param {boolean} approved */
  resolveApproval(id, approved) {
    const resolve = this.pending.get(id);
    if (!resolve) return false;
    this.pending.delete(id);
    resolve(approved);
    return true;
  }

  /**
   * Replace the ongoing notification with the result.
   *
   * A finished turn is the thing you actually want to be told about on a phone,
   * because you have almost certainly switched away from the browser. It does not
   * vibrate: only a blocked approval does, since something that buzzes on every
   * completion is something you turn off within a day.
   * @param {{kind: "done"|"aborted"|"error"|"stuck", detail: string}} outcome
   * @param {string} lastText
   */
  notifyOutcome(outcome, lastText) {
    if (this.kind !== "root") return;
    const body = (outcome.detail || lastText || "").replace(/\s+/g, " ").trim().slice(0, 220);
    if (outcome.kind === "aborted") {
      clearNotification().catch(() => {});
      return;
    }
    const title =
      outcome.kind === "done"
        ? "Agent finished"
        : outcome.kind === "stuck"
          ? `Agent stopped: no progress on ${outcome.detail}`
          : "Agent failed";
    notify({ title, body, priority: outcome.kind === "done" ? "default" : "high" }).catch(() => {});
  }

  /** Ask the UI, block this tool call until an answer arrives. */
  approve = ({ command, cwd, reason, kind = "command" }) => {
    const id = `${this.idPrefix}ap_${++this.seq}`;
    this.emit({ type: "approval_request", id, kind, command, cwd, reason });
    // The turn is now stopped until the user answers, and on a phone they are
    // probably in another app. A notification is the only thing that tells them.
    notify({
      title: kind === "edit" ? "Agent needs approval: file change" : "Agent needs approval: command",
      body: String(command || "").slice(0, 200),
      priority: "high",
      ongoing: true,
    }).catch(() => {});
    vibrate().catch(() => {});
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          this.emit({ type: "approval_closed", id, outcome: "timeout" });
          this.emit({ type: "tool_note", text: "Approval timed out after 10 minutes; nothing was run or changed." });
          notify({ title: "Approval timed out", body: "Nothing was run or changed.", priority: "low" }).catch(() => {});
          resolve(false);
        }
      }, APPROVAL_TIMEOUT);
      this.pending.set(id, (ok) => {
        clearTimeout(timer);
        // Back to work: replace the "needs you" notification with the working one.
        notify({ title: "Agent working\u2026", priority: "low", ongoing: true }).catch(() => {});
        resolve(ok);
      });
    });
  };

  /**
   * Run a delegated task and return only its final text.
   *
   * The sub-agent's tool activity is emitted so the user can watch it, nested
   * under an id - a spinner that says "working" for two minutes with nothing
   * behind it is indistinguishable from a hang, which on a phone is the failure
   * users report.
   * @param {{prompt: string, kind: string}} args
   */
  spawnAgent = async ({ prompt, kind }) => {
    const id = `${this.idPrefix}sub_${++this.subSeq}`;
    const sub = new Agent({
      config: this.config,
      emit: (e) => {
        if (SUBAGENT_EVENTS.has(e.type)) this.emit({ ...e, subagent: id });
      },
      kind: /** @type {"explore"|"general"} */ (kind),
      parentSignal: this.controller.signal,
      idPrefix: `${id}_`,
    });
    // Approvals must reach the user, not the sub-agent's own empty map.
    sub.approve = this.approve;
    this.emit({ type: "subagent_start", id, kind });
    try {
      const answer = await sub.run(prompt);
      this.addSpend(sub.spend);
      this.emit({ type: "subagent_end", id, ok: true });
      return answer;
    } catch (err) {
      this.addSpend(sub.spend);
      const message = /** @type {Error} */ (err).message;
      this.emit({ type: "subagent_end", id, ok: false, error: message });
      return `[the sub-agent failed: ${message}]`;
    }
  };

  /** @param {typeof this.spend} other */
  addSpend(other) {
    this.spend.input += other.input;
    this.spend.output += other.output;
    this.spend.cacheRead += other.cacheRead;
    this.spend.cacheWrite += other.cacheWrite;
    this.spend.cost += other.cost;
  }

  /**
   * Summarise the older part of the history when it no longer fits.
   *
   * Done before the request rather than after a failure, because the failure mode
   * it prevents is a 400 from the provider - by which point the user has already
   * waited for a round trip that could never have worked.
   * @param {any[]} messages
   * @param {number} contextWindow
   * @param {import("./config.js").ProviderConfig} provider
   */
  async maybeCompact(messages, contextWindow, provider) {
    const { cut, tokens, limit } = planCompaction(messages, contextWindow);
    if (!cut) return messages;

    this.emit({ type: "compacting", tokens, limit });
    const prefix = messages.slice(0, cut);
    // Recognise our own previous summary so the second round of compaction folds
    // it in rather than quoting it: without this, each round wraps the last and
    // the summary grows instead of holding steady.
    const carried = String(prefix[0]?.content || "").startsWith(SUMMARY_MARKER);
    const previousSummary = carried ? String(prefix[0].content).slice(SUMMARY_MARKER.length).trim() : "";
    const head = carried ? (prefix[1]?.role === "assistant" ? 2 : 1) : 0;
    const summary = await summarize({
      provider,
      messages: prefix.slice(head),
      previousSummary,
      signal: this.controller.signal,
    });
    if (!summary) return messages; // summariser failed; better to try the big prompt than to lose it

    await this.history.checkpoint(summary, cut);
    const next = this.history.get();
    this.emit({
      type: "compacted",
      dropped: cut,
      before: tokens,
      after: estimateTokens(next),
    });
    return next;
  }

  /**
   * @param {string} text
   * @returns {Promise<string>} the assistant's final text
   */
  async run(text) {
    if (this.running) throw new Error("this session already has a turn in flight");
    this.running = true;

    const provider = this.config.providers[this.config.active];
    if (!provider) throw new Error("No provider configured. Open Settings and add one.");
    if (!provider.apiKey && !/^https?:\/\/(127\.0\.0\.1|localhost|10\.|192\.168\.)/.test(provider.baseUrl)) {
      throw new Error(`Provider "${this.config.active}" has no API key. Open Settings.`);
    }

    const workspace = this.config.workspace;
    fs.mkdirSync(workspace, { recursive: true });
    const model = catalogEntry(this.config, provider);
    const contextWindow = model?.context || FALLBACK_CONTEXT_WINDOW;

    /** @type {import("./tools.js").ToolContext} */
    const ctx = {
      workspace,
      autoApproveCommands: this.config.autoApproveCommands,
      autoApproveEdits: this.config.autoApproveEdits !== false,
      verifyEdits: this.config.verifyEdits !== false,
      mode: this.mode,
      denyCommands: this.config.denyCommands,
      approve: this.approve,
      signal: this.controller.signal,
      sessionId: this.sessionId,
      // Straight to the UI: a plan the user cannot see is only half useful.
      onTodo: (items) => this.emit({ type: "todo", items }),
      ...(this.kind === "root" ? { spawnAgent: this.spawnAgent } : {}),
    };

    await this.history.append({ role: "user", content: text });
    if (this.kind === "root") {
      const title = await maybeSetTitle(this.sessionId, text);
      this.emit({ type: "title", title });
    }

    const specs = toolSpecs({ mode: this.mode, kind: this.kind });

    if (this.kind === "root") {
      // One ongoing notification for the whole turn, replaced at the end by the
      // result. Without it there is nothing on a phone to say the agent is busy.
      notify({ title: "Agent working\u2026", body: text.slice(0, 120), priority: "low", ongoing: true }).catch(() => {});
    }

    /** @type {{kind: "done"|"aborted"|"error"|"stuck", detail: string}} */
    let outcome = { kind: "error", detail: "" };
    /** Last thing the model said, which is the useful notification body. */
    let lastText = "";
    /** Fingerprints of recent tool batches, for the no-progress check below. */
    /** @type {string[]} */
    const recent = [];
    let step = 0;

    try {
      for (;;) {
        step += 1;
        // Rebuilt every step: AGENTS.md and the plan can both have changed, and a
        // stale plan in the prompt is worse than none.
        const system = this.buildSystemPrompt();

        let history = repairHistory(this.history.get());
        history = await this.maybeCompact(history, contextWindow, provider);
        history = repairHistory(history);

        // The invariant both wire formats enforce. If this ever trips it is our
        // bug, and saying so beats a provider 400 that names no cause.
        const broken = pairingErrors(history);
        if (broken.length) {
          throw new Error(`internal: history is not sendable (${broken.slice(0, 3).join("; ")})`);
        }

        let assistantText = "";
        let reasoning = "";
        let reasoningSignature = "";
        /** @type {Array<{id: string, name: string, input: any}>} */
        const toolCalls = [];
        let usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
        let stopReason = "stop";

        for await (const ev of stream({
          provider,
          system,
          messages: history,
          tools: specs,
          signal: this.controller.signal,
        })) {
          if (ev.type === "text") {
            assistantText += ev.text;
            lastText = assistantText;
            this.emit({ type: "text_delta", text: ev.text });
          } else if (ev.type === "reasoning") {
            reasoning += ev.text;
            this.emit({ type: "reasoning_delta", text: ev.text });
          } else if (ev.type === "signature") {
            reasoningSignature += ev.signature;
          } else if (ev.type === "tool_call") {
            toolCalls.push({ id: ev.id, name: ev.name, input: ev.input });
          } else if (ev.type === "usage") {
            usage = { input: ev.input, output: ev.output, cacheRead: ev.cacheRead, cacheWrite: ev.cacheWrite };
          } else if (ev.type === "stop") {
            stopReason = ev.reason;
          }
        }

        if (usage.input || usage.output) {
          const cost = costOf(model, usage);
          this.addSpend({ ...usage, cost: cost || 0 });
          this.emit({
            type: "usage",
            ...usage,
            cost,
            turnCost: this.spend.cost,
            contextWindow,
            contextUsed: usage.input || estimateTokens(history),
          });
        }

        await this.history.append({
          role: "assistant",
          content: assistantText,
          ...(reasoning ? { reasoning } : {}),
          ...(reasoningSignature ? { reasoningSignature } : {}),
          ...(toolCalls.length ? { toolCalls } : {}),
          usage,
        });
        this.emit({ type: "assistant_end" });

        if (!toolCalls.length) {
          outcome = { kind: "done", detail: assistantText.trim() };
          this.emit({ type: "done", stopReason });
          return assistantText.trim();
        }

        const results = await this.runTools(toolCalls, ctx);
        await this.history.append({ role: "tool", results });

        if (this.controller.signal.aborted) {
          outcome = { kind: "aborted", detail: "" };
          this.emit({ type: "done", stopReason: "aborted" });
          return lastText;
        }

        // The only thing left that stops the loop, now that there is no step
        // budget. Not a cap in disguise: it fires on identical work producing
        // identical output, which is never progress, and never on a long task
        // that is getting somewhere.
        //
        // The results are part of the fingerprint, not just the calls. Both
        // halves matter. Without the results, a poller that legitimately re-reads
        // the same file waiting for it to change looks stuck. Without the calls,
        // nothing is comparable at all. And including the results is what catches
        // the worse case: a tool failing the same way forever, which used to be
        // bounded by the step limit and would otherwise now run until the credit
        // ran out.
        const fingerprint = hashStep(toolCalls, results);
        recent.push(fingerprint);
        if (recent.length > NO_PROGRESS_REPEATS) recent.shift();
        if (recent.length === NO_PROGRESS_REPEATS && recent.every((f) => f === fingerprint)) {
          const names = [...new Set(toolCalls.map((c) => c.name))].join(", ");
          outcome = { kind: "stuck", detail: names };
          this.emit({
            type: "error",
            message:
              `Stopped after ${step} steps: the same call (${names}) was repeated ${NO_PROGRESS_REPEATS} times ` +
              `with identical arguments and identical results, so it is not making progress. ` +
              `Rephrase the task or tell it what to try instead.`,
          });
          return lastText;
        }
      }
    } catch (err) {
      const e = /** @type {Error} */ (err);
      if (this.controller.signal.aborted || e.name === "AbortError") {
        outcome = { kind: "aborted", detail: "" };
        this.emit({ type: "done", stopReason: "aborted" });
        return lastText;
      }
      const message = e instanceof ProviderError ? e.message : `${e.name}: ${e.message}`;
      outcome = { kind: "error", detail: message };
      this.emit({ type: "error", message });
      if (this.kind !== "root") throw e; // the parent turns this into a tool error
      return lastText;
    } finally {
      this.running = false;
      // Every exit path lands here, so the notification cannot be left saying
      // "working" after a turn that crashed or was stopped.
      this.notifyOutcome(outcome, lastText);
    }
  }

  /**
   * Execute a batch of tool calls with as much parallelism as is safe.
   *
   * The ordering rules exist because the model asks for things that genuinely
   * conflict:
   *   - reads are independent, so they all go at once;
   *   - two writes to the same path must not interleave, and a read of a path
   *     being written must wait, or the model sees half a file it just wrote;
   *   - run_command waits for everything, because a test run has to see the
   *     finished state of the tree and not a half-applied edit.
   *
   * @param {Array<{id: string, name: string, input: any}>} toolCalls
   * @param {import("./tools.js").ToolContext} ctx
   */
  async runTools(toolCalls, ctx) {
    const WRITE_TOOLS = new Set(["write_file", "edit_file", "move_file", "delete_file", "patch_file"]);

    /** @type {Array<{id: string, name: string, output: string, ok: boolean}>} */
    const results = new Array(toolCalls.length);
    /** path -> promise of the last write queued on it */
    const writeLocks = new Map();
    /** @type {Promise<any>[]} */
    const runningTasks = [];

    for (const [idx, call] of toolCalls.entries()) {
      this.emit({ type: "tool_start", id: call.id, name: call.name, input: call.input });

      let task;
      if (call.name === "run_command") {
        task = Promise.all(runningTasks.slice()).then(() => callTool(call.name, call.input, ctx));
      } else if (WRITE_TOOLS.has(call.name)) {
        // move_file touches both src and dst; lock both so a parallel read/write
        // on either path in this same batch waits its turn.
        const paths = [call.input?.path, call.input?.src, call.input?.dst].filter(Boolean);
        if (!paths.length) paths.push("__unknown__");
        const prev = Promise.all(paths.map((p) => writeLocks.get(p) || Promise.resolve()));
        task = prev.then(() => callTool(call.name, call.input, ctx));
        const settled = task.catch(() => {});
        for (const p of paths) writeLocks.set(p, settled);
      } else {
        const p = call.input?.path;
        const prev = p && writeLocks.has(p) ? writeLocks.get(p) : Promise.resolve();
        task = prev.then(() => callTool(call.name, call.input, ctx));
      }

      runningTasks.push(
        task.then(({ ok, output }) => {
          this.emit({ type: "tool_end", id: call.id, name: call.name, ok, output });
          results[idx] = { id: call.id, name: call.name, output, ok };
        }),
      );
    }

    await Promise.all(runningTasks);
    return results;
  }
}

/** The name the daemon and tests have always used. */
export { Agent as Runner };
