/**
 * The agent loop: user text -> model -> tools -> model -> ... -> answer.
 *
 * One Runner owns one in-flight turn for one session. The daemon keeps a map of
 * them so Stop and approval replies can reach the right turn.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { stream, ProviderError } from "./provider.js";
import { callTool, toolSpecs, pickShell } from "./tools.js";
import { appendMessage, getSession, maybeSetTitle, readTodos } from "./store.js";
import { modelsFor } from "./catalog.js";
import { clearNotification, notify, vibrate } from "./notify.js";

const APPROVAL_TIMEOUT = 10 * 60_000;
const FALLBACK_CONTEXT_WINDOW = 128_000; // used only when the catalog has no entry for this model
/** Project conventions, read fresh every turn so editing the file takes effect. */
const AGENTS_FILE = "AGENTS.md";
const AGENTS_MAX = 8_000;

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
function contextWindowFor(config, provider) {
  const known = modelsFor(config.active).find((m) => m.id === provider.model);
  return known?.context || FALLBACK_CONTEXT_WINDOW;
}

/**
 * @param {import("./config.js").Config} config
 * @param {string} workspace
 */
function systemPrompt(config, workspace, todos = []) {
  const shell = pickShell().shell;
  const termux = Boolean(process.env.TERMUX_VERSION);
  const projectNotes = projectInstructions(workspace);
  const openPlan = todos.length && todos.some((x) => x.status !== "done")
    ? todos.map((x) => `[${x.status === "done" ? "x" : x.status === "in_progress" ? ">" : " "}] ${x.text}`).join("\n")
    : "";
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
    "How to work:",
    "- Read before you write. Never guess a file's contents or a function's signature; open it.",
    "- Prefer edit_file over write_file for existing files, so you do not destroy code you have not read.",
    "- Use the dedicated tools for files and search. Reach for run_command only for things that genuinely need a shell: git, tests, builds, package managers.",
    "- After changing code, run the project's build or tests if they exist. Report what you actually ran, not what you assume works.",
    "- Work in small verified steps. If the same approach fails twice, stop and diagnose the cause instead of retrying variations.",
    "- If a tool returns an error, read it and adapt. Tool errors are information, not a reason to stop.",
    "",
    "Style:",
    "- Answers are read on a phone screen. Be brief. Lead with the result.",
    "- No preamble like 'Let me...' or 'I will now...'. Just act, then report.",
    "- Reference code as path:line so the user can jump to it.",
    "- Say plainly when something did not work or you could not verify it.",
    config.instructions ? `\nUser instructions:\n${config.instructions}` : "",
    projectNotes ? `\nProject instructions (from ${AGENTS_FILE} in the workspace, these take precedence):\n${projectNotes}` : "",
    openPlan ? `\nYour plan for this task so far (keep it current with todo_write):\n${openPlan}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}
/**
 * If the message history is very long, summarise the middle portion to keep
 * context windows manageable. Keeps the first 2 messages (system context) and
 * the last 6 messages (recent context) verbatim; summarises the rest as a
 * single assistant note.
 * @param {any[]} messages
 * @returns {any[]}
 */
function compactHistory(messages) {
  const KEEP_HEAD = 2;
  const KEEP_TAIL = 6;
  const COMPACT_THRESHOLD = 30; // only compact if more than this many messages
  if (messages.length <= COMPACT_THRESHOLD) return messages;
  const head = messages.slice(0, KEEP_HEAD);
  const tail = messages.slice(-KEEP_TAIL);
  const middle = messages.slice(KEEP_HEAD, messages.length - KEEP_TAIL);
  const summary = middle.map(m => {
    if (m.role === 'user') return `User: ${String(m.content || '').slice(0, 200)}`;
    if (m.role === 'assistant') return `Assistant: ${String(m.content || '').slice(0, 200)}${m.toolCalls?.length ? ` [used ${m.toolCalls.length} tool(s)]` : ''}`;
    if (m.role === 'tool') return `Tools: ${m.results?.map(r => r.name).join(', ')}`;
    return '';
  }).filter(Boolean).join('\n');
  const compacted = { role: 'assistant', content: `[Earlier conversation summary - ${middle.length} messages]:\n${summary}` };
  return [...head, compacted, ...tail];
}

export class Runner {
  /**
   * @param {object} args
   * @param {string} args.sessionId
   * @param {import("./config.js").Config} args.config
   * @param {(event: any) => void} args.emit
   */
  constructor({ sessionId, config, emit }) {
    this.sessionId = sessionId;
    this.config = config;
    this.emit = emit;
    this.controller = new AbortController();
    /** @type {Map<string, (ok: boolean) => void>} */
    this.pending = new Map();
    this.running = false;
    this.seq = 0;
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
    return systemPrompt(this.config, this.config.workspace, readTodos(this.sessionId));
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
   * @param {{kind: "done"|"aborted"|"error"|"exhausted", detail: string}} outcome
   * @param {string} lastText
   */
  notifyOutcome(outcome, lastText) {
    const body = (outcome.detail || lastText || "").replace(/\s+/g, " ").trim().slice(0, 220);
    if (outcome.kind === "aborted") {
      clearNotification().catch(() => {});
      return;
    }
    const title =
      outcome.kind === "done"
        ? "Agent finished"
        : outcome.kind === "exhausted"
          ? `Agent stopped after ${outcome.detail} steps`
          : "Agent failed";
    notify({ title, body, priority: outcome.kind === "done" ? "default" : "high" }).catch(() => {});
  }

  /** Ask the UI, block this tool call until an answer arrives. */
  approve = ({ command, cwd, reason, kind = "command" }) => {
    const id = `ap_${++this.seq}`;
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

  /** @param {string} text */
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

    const ctx = {
      workspace,
      autoApproveCommands: this.config.autoApproveCommands,
      autoApproveEdits: this.config.autoApproveEdits !== false,
      denyCommands: this.config.denyCommands,
      approve: this.approve,
      signal: this.controller.signal,
      sessionId: this.sessionId,
      // Straight to the UI: a plan the user cannot see is only half useful.
      onTodo: (items) => this.emit({ type: "todo", items }),
    };

    await appendMessage(this.sessionId, { role: "user", content: text });
    const title = await maybeSetTitle(this.sessionId, text);
    this.emit({ type: "title", title });

    // The plan survives compaction this way. The tool result that created it can
    // be summarised away halfway through a long task, and losing the checklist is
    // exactly when the agent starts repeating itself.
    const system = this.buildSystemPrompt();
    const specs = toolSpecs();
    const maxSteps = this.config.maxSteps || 40;

    // One ongoing notification for the whole turn, replaced at the end by the
    // result. Without it there is nothing on a phone to say the agent is busy.
    notify({ title: "Agent working\u2026", body: text.slice(0, 120), priority: "low", ongoing: true }).catch(() => {});
    /** @type {{kind: "done"|"aborted"|"error"|"exhausted", detail: string}} */
    let outcome = { kind: "error", detail: "" };
    /** Last thing the model said, which is the useful notification body. */
    let lastText = "";

    try {
      for (let step = 0; step < maxSteps; step++) {
        const history = compactHistory(getSession(this.sessionId).messages);

        let assistantText = "";
        // Kept outside the loop too: on an error the last thing said is the
        // most useful thing to put in the notification.
        /** @type {Array<{id: string, name: string, input: any}>} */
        const toolCalls = [];
        let usage = { input: 0, output: 0 };
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
          } else if (ev.type === "tool_call") {
            toolCalls.push({ id: ev.id, name: ev.name, input: ev.input });
          } else if (ev.type === "usage") {
            usage = { input: ev.input, output: ev.output };
          } else if (ev.type === "stop") {
            stopReason = ev.reason;
          }
        }

        if (usage.input || usage.output) this.emit({ type: "usage", ...usage });

        // Warn if token usage is approaching the model's real context window
        // (not provider.maxTokens, which is the output cap - see contextWindowFor).
        const contextWindow = contextWindowFor(this.config, provider);
        if (usage.input && usage.input > contextWindow * 0.8) {
          this.emit({ type: "tool_note", text: `⚠️ Context usage high: ${usage.input.toLocaleString()} / ~${contextWindow.toLocaleString()} input tokens. Consider starting a new session soon.` });
        }

        await appendMessage(this.sessionId, {
          role: "assistant",
          content: assistantText,
          ...(toolCalls.length ? { toolCalls } : {}),
          usage,
        });

        if (!toolCalls.length) {
          outcome = { kind: "done", detail: assistantText.trim() };
          this.emit({ type: "done", stopReason });
          return;
        }

        // Smart parallel execution:
        // - Read-only tools run in parallel
        // - Write tools on the same file run sequentially (prevent data races)
        // - run_command always waits for all ongoing ops first
        const READ_ONLY = new Set(['read_file','batch_read','glob','grep','list_dir','tree','read_url']);
        const WRITE_TOOLS = new Set(['write_file','edit_file','move_file','delete_file','patch_file']);

        /** @type {Array<{id: string, name: string, output: string, ok: boolean}>} */
        const results = new Array(toolCalls.length);
        // file-path -> promise of last write on that path (for sequencing writes)
        const writeLocks = new Map();
        // promise that must settle before run_command can start
        /** @type {Promise<any>} */
        let allPending = Promise.resolve();
        const runningTasks = [];

        for (let ci = 0; ci < toolCalls.length; ci++) {
          const call = toolCalls[ci];
          const idx = ci;
          this.emit({ type: "tool_start", id: call.id, name: call.name, input: call.input });

          let task;
          if (call.name === 'run_command') {
            // Wait for everything in flight before running a shell command
            task = Promise.all(runningTasks.filter(Boolean)).then(() =>
              callTool(call.name, call.input, ctx)
            );
          } else if (WRITE_TOOLS.has(call.name)) {
            // move_file touches both src and dst; lock both so a parallel
            // read/write on either path in this same batch waits its turn.
            const paths = [call.input?.path, call.input?.src, call.input?.dst].filter(Boolean);
            if (!paths.length) paths.push('__unknown__');
            const prev = Promise.all(paths.map((p) => writeLocks.get(p) || Promise.resolve()));
            task = prev.then(() => callTool(call.name, call.input, ctx));
            const settled = task.catch(() => {});
            for (const p of paths) writeLocks.set(p, settled);
          } else {
            // Read-only, but still wait for any write already queued on the
            // same path in this batch so it never sees a half-written file.
            const p = call.input?.path;
            const prev = p && writeLocks.has(p) ? writeLocks.get(p) : Promise.resolve();
            task = prev.then(() => callTool(call.name, call.input, ctx));
          }

          const tracked = task.then(({ ok, output }) => {
            this.emit({ type: "tool_end", id: call.id, name: call.name, ok, output });
            results[idx] = { id: call.id, name: call.name, output, ok };
          });
          runningTasks.push(tracked);
          allPending = Promise.all(runningTasks);
        }

        await allPending;

        await appendMessage(this.sessionId, { role: "tool", results });

        if (this.controller.signal.aborted) {
          outcome = { kind: "aborted", detail: "" };
          this.emit({ type: "done", stopReason: "aborted" });
          return;
        }
      }

      outcome = { kind: "exhausted", detail: String(maxSteps) };
      this.emit({
        type: "error",
        message: `Stopped after ${maxSteps} steps without finishing. Raise maxSteps in Settings or split the task.`,
      });
    } catch (err) {
      const e = /** @type {Error} */ (err);
      if (this.controller.signal.aborted || e.name === "AbortError") {
        outcome = { kind: "aborted", detail: "" };
        this.emit({ type: "done", stopReason: "aborted" });
        return;
      }
      const message = e instanceof ProviderError ? e.message : `${e.name}: ${e.message}`;
      outcome = { kind: "error", detail: message };
      this.emit({ type: "error", message });
    } finally {
      this.running = false;
      // Every exit path lands here, so the notification cannot be left saying
      // "working" after a turn that crashed or was stopped.
      this.notifyOutcome(outcome, lastText);
    }
  }
}
