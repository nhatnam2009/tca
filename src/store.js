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
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { STATE_DIR } from "./config.js";

const DIR = path.join(STATE_DIR, "sessions");

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
 * @property {ToolCallRecord[]} [toolCalls]
 * @property {Array<{id: string, name: string, output: string, ok: boolean}>} [results]
 * @property {{input: number, output: number}} [usage]
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

/** Parse a session file, tolerating a truncated final line. */
function parse(id) {
  const raw = fs.readFileSync(file(id), "utf8");
  const lines = raw.split("\n").filter(Boolean);
  let meta = { type: "meta", id, title: "New session", createdAt: 0 };
  /** @type {Message[]} */
  const messages = [];
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
    else messages.push(rec);
  }
  return { meta, messages };
}

/** @returns {{id: string, title: string, messages: Message[]}} */
export function getSession(id) {
  ensure();
  if (!fs.existsSync(file(id))) throw new Error(`no such session: ${id}`);
  const { meta, messages } = parse(id);
  return { id, title: meta.title, messages };
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

/**
 * @param {string} id
 * @param {Message} message
 */
export async function appendMessage(id, message) {
  ensure();
  await fsp.appendFile(file(id), `${JSON.stringify({ ...message, at: Date.now() })}\n`);
}

/** First user message becomes the title, trimmed to something that fits a phone. */
export async function maybeSetTitle(id, text) {
  const { meta, messages } = parse(id);
  if (meta.title !== "New session") return meta.title;
  if (messages.filter((m) => m.role === "user").length > 1) return meta.title;
  const title = text.replace(/\s+/g, " ").trim().slice(0, 60) || "New session";
  await fsp.appendFile(file(id), `${JSON.stringify({ type: "title", title })}\n`);
  return title;
}

export function deleteSession(id) {
  ensure();
  fs.rmSync(file(id), { force: true });
}
