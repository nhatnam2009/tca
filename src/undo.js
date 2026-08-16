/**
 * Undo / Redo engine for file modifications.
 *
 * Persists changes per session in ~/.tca/undo/<session-id>.jsonl with before/after
 * SHA-256 hashes to prevent overwriting manual user edits.
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

export const UNDO_DIR = path.join(os.homedir(), ".tca", "undo");

export function sha256(content) {
  if (content == null) return null;
  return createHash("sha256")
    .update(Buffer.isBuffer(content) ? content : String(content), "utf8")
    .digest("hex");
}

function undoFilePath(sessionId) {
  return path.join(UNDO_DIR, `${sessionId}.jsonl`);
}

function redoFilePath(sessionId) {
  return path.join(UNDO_DIR, `${sessionId}.redo.jsonl`);
}

/**
 * Append a file modification record to the undo log.
 * @param {object} param
 * @param {string} param.sessionId
 * @param {number} param.turn
 * @param {string} param.tool
 * @param {string} param.relPath
 * @param {string|null} param.beforeContent
 * @param {string|null} param.afterContent
 * @param {string} [param.workspace]
 */
export async function recordFileChange({
  sessionId,
  turn,
  tool,
  relPath,
  beforeContent,
  afterContent,
  workspace,
}) {
  if (!sessionId) return;
  await fsp.mkdir(UNDO_DIR, { recursive: true });

  const record = {
    ts: Date.now(),
    turn: Number(turn) || 1,
    tool: String(tool || "write_file"),
    relPath: String(relPath),
    beforeContent: beforeContent != null ? String(beforeContent) : null,
    afterContent: afterContent != null ? String(afterContent) : null,
    beforeHash: sha256(beforeContent),
    afterHash: sha256(afterContent),
  };

  const line = JSON.stringify(record) + "\n";
  await fsp.appendFile(undoFilePath(sessionId), line, "utf8");

  // A new change invalidates the existing redo stack
  const redoPath = redoFilePath(sessionId);
  if (fs.existsSync(redoPath)) {
    await fsp.unlink(redoPath).catch(() => {});
  }
}

/**
 * Read the full undo history for a session.
 * @param {string} sessionId
 * @returns {Promise<Array<any>>}
 */
export async function getUndoHistory(sessionId) {
  const filePath = undoFilePath(sessionId);
  if (!fs.existsSync(filePath)) return [];
  try {
    const raw = await fsp.readFile(filePath, "utf8");
    return raw
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

/**
 * Read the full redo stack for a session.
 * @param {string} sessionId
 * @returns {Promise<Array<any>>}
 */
export async function getRedoHistory(sessionId) {
  const filePath = redoFilePath(sessionId);
  if (!fs.existsSync(filePath)) return [];
  try {
    const raw = await fsp.readFile(filePath, "utf8");
    return raw
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

/**
 * Undo all file changes from the last recorded turn in a session.
 * @param {string} sessionId
 * @param {string} workspacePath
 * @returns {Promise<{ok: boolean, turn?: number, reverted?: string[], message?: string, conflict?: boolean}>}
 */
export async function undoLastTurn(sessionId, workspacePath) {
  const history = await getUndoHistory(sessionId);
  if (!history.length) {
    return { ok: false, message: "Nothing to undo" };
  }

  const lastTurn = history[history.length - 1].turn;
  const turnRecords = history.filter((r) => r.turn === lastTurn);
  const remaining = history.filter((r) => r.turn !== lastTurn);

  // 1. Verify hash of each file matches afterHash before reverting
  for (const record of turnRecords) {
    const absPath = path.resolve(workspacePath, record.relPath);
    let currentContent = null;
    try {
      currentContent = await fsp.readFile(absPath, "utf8");
    } catch {
      currentContent = null;
    }
    const currentHash = sha256(currentContent);
    if (currentHash !== record.afterHash) {
      return {
        ok: false,
        conflict: true,
        message: `Conflict: ${record.relPath} has been modified since last turn`,
      };
    }
  }

  // 2. Revert files (in reverse order of edits)
  const reverted = [];
  for (let i = turnRecords.length - 1; i >= 0; i--) {
    const record = turnRecords[i];
    const absPath = path.resolve(workspacePath, record.relPath);
    if (record.beforeContent === null) {
      // File was newly created -> remove it
      await fsp.unlink(absPath).catch(() => {});
    } else {
      // Restore previous content
      await fsp.mkdir(path.dirname(absPath), { recursive: true });
      await fsp.writeFile(absPath, record.beforeContent, "utf8");
    }
    reverted.push(record.relPath);
  }

  // 3. Update undo log (keep remaining)
  const newUndoContent = remaining.map((r) => JSON.stringify(r)).join("\n") + (remaining.length ? "\n" : "");
  await fsp.writeFile(undoFilePath(sessionId), newUndoContent, "utf8");

  // 4. Append to redo log
  const redoLine = turnRecords.map((r) => JSON.stringify(r)).join("\n") + "\n";
  await fsp.appendFile(redoFilePath(sessionId), redoLine, "utf8");

  return { ok: true, turn: lastTurn, reverted };
}

/**
 * Redo the last undone turn in a session.
 * @param {string} sessionId
 * @param {string} workspacePath
 * @returns {Promise<{ok: boolean, turn?: number, reapplied?: string[], message?: string, conflict?: boolean}>}
 */
export async function redoLastTurn(sessionId, workspacePath) {
  const redoStack = await getRedoHistory(sessionId);
  if (!redoStack.length) {
    return { ok: false, message: "Nothing to redo" };
  }

  const lastTurn = redoStack[redoStack.length - 1].turn;
  const turnRecords = redoStack.filter((r) => r.turn === lastTurn);
  const remaining = redoStack.filter((r) => r.turn !== lastTurn);

  // 1. Verify hash of each file matches beforeHash before reapplying
  for (const record of turnRecords) {
    const absPath = path.resolve(workspacePath, record.relPath);
    let currentContent = null;
    try {
      currentContent = await fsp.readFile(absPath, "utf8");
    } catch {
      currentContent = null;
    }
    const currentHash = sha256(currentContent);
    if (currentHash !== record.beforeHash) {
      return {
        ok: false,
        conflict: true,
        message: `Conflict: ${record.relPath} has been modified`,
      };
    }
  }

  // 2. Reapply changes
  const reapplied = [];
  for (const record of turnRecords) {
    const absPath = path.resolve(workspacePath, record.relPath);
    if (record.afterContent === null) {
      await fsp.unlink(absPath).catch(() => {});
    } else {
      await fsp.mkdir(path.dirname(absPath), { recursive: true });
      await fsp.writeFile(absPath, record.afterContent, "utf8");
    }
    reapplied.push(record.relPath);
  }

  // 3. Update redo log
  const newRedoContent = remaining.map((r) => JSON.stringify(r)).join("\n") + (remaining.length ? "\n" : "");
  await fsp.writeFile(redoFilePath(sessionId), newRedoContent, "utf8");

  // 4. Append back to undo log
  const undoLine = turnRecords.map((r) => JSON.stringify(r)).join("\n") + "\n";
  await fsp.appendFile(undoFilePath(sessionId), undoLine, "utf8");

  return { ok: true, turn: lastTurn, reapplied };
}
