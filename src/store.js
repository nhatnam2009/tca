/**
 * Session storage: one JSONL file per session under ~/.tca/sessions/.
 *
 * Deliberately not SQLite. node:sqlite is only stable in Node 24 and
 * better-sqlite3 needs a clang build on the phone; a JSONL append is crash-safe
 * enough for chat history, survives a killed process mid-write (the last
 * partial line is dropped on read), and stays greppable from the shell.
 *
 * Chat history stays in private storage, never on /sdcard: it contains whatever
 * the agent read out of your source files.
 *
 * Two kinds of read:
 *   getSession()      everything, for the UI - the user gets to scroll back.
 *   agentHistory()    what the model sees, with compaction checkpoints applied.
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { STATE_DIR } from "./config.js";

const DIR = path.join(STATE_DIR, "sessions");
const TODO_DIR = path.join(STATE_DIR, "todos");

/**
 * @typedef {object} ToolCallRecord
 * @property {string} id
 * @property {string} name
 * @property {any} input
 * @property {string} [output]
 * @property {boolean} [ok]
 *
 * @typedef {object} Message
 * @property {"user"|"assistant"|"tool"} role
 * @property {string} [content]
 * @property {string} [reasoning]        thinking text, kept out of the visible body
 * @property {ToolCallRecord[]} [toolCalls]
 * @property {Array<{id: string, name: string, output: string, ok: boolean}>} [results]
 * @property {{input: number, output: number, cacheRead?: number, cacheWrite?: number}} [usage]
 * @property {number} [at]
 */

function ensure() {
  fs.mkdirSync(DIR, { recursive: true });
}

function file(id) {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error(`bad session id: ${id}`);
  return path.join(DIR, `${id}.jsonl`);
}

/** @returns {{id: string}} */
export function createSession() {
  ensure();
  const id = `${Date.now().toString(36)}${crypto.randomBytes(3).toString("hex")}`;
  const meta = { type: "meta", id, title: "New session", createdAt: Date.now() };
  fs.writeFileSync(file(id), `${JSON.stringify(meta)}\n`, { mode: 0o600 });
  return { id };
}

/**
 * Parsed sessions, keyed by id.
 *
 * The agent loop asks for the history once per step, and a 40-step turn with
 * large tool outputs used to mean 40 full reads and 40 full JSON.parse passes of
 * a file that only grows - quadratic work on a phone's flash for a file we wrote
 * ourselves. Cached on file size: this process is the only writer, and a size
 * change is enough to catch an external edit, at the cost of one stat().
 * @type {Map<string, {size: number, meta: any, messages: Message[], checkpoint: {summary: string, through: number} | null}>}
 */
const cache = new Map();

/** Parse a session file, tolerating a truncated final line. */
function parse(id) {
  const f = file(id);
  const stat = fs.statSync(f);
  const hit = cache.get(id);
  if (hit && hit.size === stat.size) return hit;

  const raw = fs.readFileSync(f, "utf8");
  const lines = raw.split("\n").filter(Boolean);
  let meta = { type: "meta", id, title: "New session", createdAt: 0 };
  /** @type {Message[]} */
  const messages = [];
  /** @type {{summary: string, through: number} | null} */
  let checkpoint = null;

  for (const [i, line] of lines.entries()) {
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      if (i === lines.length - 1) break; // killed mid-append, ignore
      continue;
    }
    if (rec.type === "meta") meta = { ...meta, ...rec };
    else if (rec.type === "title") meta.title = rec.title;
    else if (rec.type === "checkpoint") {
      // A later checkpoint always supersedes an earlier one: it was produced from
      // the earlier summary plus everything since.
      checkpoint = { summary: String(rec.summary || ""), through: Number(rec.through) || 0 };
    } else messages.push(rec);
  }

  const entry = { size: stat.size, meta, messages, checkpoint };
  cache.set(id, entry);
  return entry;
}

/** @returns {{id: string, title: string, messages: Message[]}} */
export function getSession(id) {
  ensure();
  if (!fs.existsSync(file(id))) throw new Error(`no such session: ${id}`);
  const { meta, messages } = parse(id);
  return { id, title: meta.title, messages };
}

/**
 * The history as the model should see it.
 *
 * Anything before the checkpoint is replaced by its summary, framed as a
 * completed exchange so the shape stays valid for both wire formats: a bare
 * assistant message full of summary would look like something the model just
 * said, which reads oddly and, on the Anthropic side, cannot be the first
 * message at all.
 * @param {string} id
 * @returns {{messages: Message[], summary: string, dropped: number}}
 */
export function agentHistory(id) {
  ensure();
  const { messages, checkpoint } = parse(id);
  if (!checkpoint || !checkpoint.summary) return { messages, summary: "", dropped: 0 };
  const kept = messages.slice(checkpoint.through);
  return {
    messages: [
      {
        role: "user",
        content: `[Earlier part of this session, compacted to fit the context window. Treat it as established fact.]\n\n${checkpoint.summary}`,
      },
      { role: "assistant", content: "Understood. Continuing from there." },
      ...kept,
    ],
    summary: checkpoint.summary,
    dropped: checkpoint.through,
  };
}

/** @returns {Array<{id: string, title: string, updatedAt: number, messageCount: number}>} */
export function listSessions() {
  ensure();
  const out = [];
  for (const name of fs.readdirSync(DIR)) {
    if (!name.endsWith(".jsonl")) continue;
    const id = name.slice(0, -6);
    try {
      const { meta, messages } = parse(id);
      out.push({
        id,
        title: meta.title,
        updatedAt: fs.statSync(path.join(DIR, name)).mtimeMs,
        messageCount: messages.filter((m) => m.role !== "tool").length,
      });
    } catch {
      // unreadable file, skip rather than break the whole list
    }
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Append a record and keep the in-memory copy in step with the file. */
async function append(id, record, apply) {
  ensure();
  const line = `${JSON.stringify(record)}\n`;
  await fsp.appendFile(file(id), line);
  const hit = cache.get(id);
  if (hit) {
    apply(hit);
    hit.size += Buffer.byteLength(line);
  }
}

/**
 * @param {string} id
 * @param {Message} message
 */
export async function appendMessage(id, message) {
  const record = { ...message, at: Date.now() };
  await append(id, record, (hit) => hit.messages.push(record));
  return record;
}

/**
 * Record that everything before `through` has been folded into `summary`.
 *
 * Append-only, like everything else here: the summarised messages stay in the
 * file so the UI can still show them, and only the model's view is narrowed.
 * @param {string} id
 * @param {string} summary
 * @param {number} through
 */
export async function appendCheckpoint(id, summary, through) {
  await append(id, { type: "checkpoint", summary, through }, (hit) => {
    hit.checkpoint = { summary, through };
  });
}

/** First user message becomes the title, trimmed to something that fits a phone. */
export async function maybeSetTitle(id, text) {
  const { meta, messages } = parse(id);
  if (meta.title !== "New session") return meta.title;
  if (messages.filter((m) => m.role === "user").length > 1) return meta.title;
  const title = text.replace(/\s+/g, " ").trim().slice(0, 60) || "New session";
  await append(id, { type: "title", title }, (hit) => {
    hit.meta.title = title;
  });
  return title;
}

export function deleteSession(id) {
  ensure();
  cache.delete(id);
  fs.rmSync(file(id), { force: true });
  fs.rmSync(todoFile(id), { force: true });
}

// ------------------------------------------------------------------- the plan

/**
 * The agent's checklist for the current task.
 *
 * Kept here rather than in the workspace on purpose: it is scratch state about a
 * conversation, not part of the user's project, and writing a todo.json into
 * someone's repository would be rude and would show up in their git status.
 *
 * @typedef {{text: string, status: "pending"|"in_progress"|"done"}} TodoItem
 */

function todoFile(id) {
  return path.join(TODO_DIR, `${id}.json`);
}

/**
 * @param {string} id
 * @returns {TodoItem[]}
 */
export function readTodos(id) {
  try {
    const raw = fs.readFileSync(todoFile(id), "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Replace the whole list. The model rewrites it in full every time rather than
 * patching individual entries, which removes any need for stable ids and any way
 * for the stored list to drift out of step with what the model believes.
 * @param {string} id
 * @param {TodoItem[]} items
 */
export function writeTodos(id, items) {
  fs.mkdirSync(TODO_DIR, { recursive: true });
  fs.writeFileSync(todoFile(id), JSON.stringify(items));
  return items;
}
