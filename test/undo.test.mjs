import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { recordFileChange, getUndoHistory, undoLastTurn, redoLastTurn, UNDO_DIR } from "../src/undo.js";
import { callTool } from "../src/tools.js";

function setupTmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tca-undo-test-"));
  return {
    workspace: dir,
    cleanup: () => {
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("write newly created file -> undo -> file is deleted", async () => {
  const { workspace, cleanup } = setupTmp();
  const sessionId = "test_undo_create_" + Date.now();
  try {
    const filePath = "new_file.txt";
    const absPath = path.join(workspace, filePath);

    // 1. Tool write_file
    const ctx = {
      workspace,
      sessionId,
      turn: 1,
      autoApproveCommands: true,
      autoApproveEdits: true,
      approve: async () => true,
    };
    await callTool("write_file", { path: filePath, content: "hello world\n" }, ctx);
    assert.equal(fs.readFileSync(absPath, "utf8"), "hello world\n");

    // Check history recorded
    const history = await getUndoHistory(sessionId);
    assert.equal(history.length, 1);
    assert.equal(history[0].tool, "write_file");
    assert.equal(history[0].beforeContent, null);

    // 2. Undo
    const res = await undoLastTurn(sessionId, workspace);
    assert.equal(res.ok, true);
    assert.deepEqual(res.reverted, [filePath]);
    assert.equal(fs.existsSync(absPath), false, "newly created file should be removed on undo");
  } finally {
    cleanup();
    fs.rmSync(path.join(UNDO_DIR, `${sessionId}.jsonl`), { force: true });
    fs.rmSync(path.join(UNDO_DIR, `${sessionId}.redo.jsonl`), { force: true });
  }
});

test("edit existing file -> undo -> file restored to original content", async () => {
  const { workspace, cleanup } = setupTmp();
  const sessionId = "test_undo_edit_" + Date.now();
  try {
    const filePath = "existing.txt";
    const absPath = path.join(workspace, filePath);
    fs.writeFileSync(absPath, "initial line 1\ninitial line 2\n", "utf8");

    const ctx = {
      workspace,
      sessionId,
      turn: 1,
      autoApproveCommands: true,
      autoApproveEdits: true,
      approve: async () => true,
    };

    await callTool("edit_file", {
      path: filePath,
      old_string: "initial line 2",
      new_string: "modified line 2",
    }, ctx);

    assert.equal(fs.readFileSync(absPath, "utf8"), "initial line 1\nmodified line 2\n");

    // Undo
    const res = await undoLastTurn(sessionId, workspace);
    assert.equal(res.ok, true);
    assert.deepEqual(res.reverted, [filePath]);
    assert.equal(fs.readFileSync(absPath, "utf8"), "initial line 1\ninitial line 2\n");
  } finally {
    cleanup();
    fs.rmSync(path.join(UNDO_DIR, `${sessionId}.jsonl`), { force: true });
    fs.rmSync(path.join(UNDO_DIR, `${sessionId}.redo.jsonl`), { force: true });
  }
});

test("undo when file modified externally -> detects conflict and does not overwrite", async () => {
  const { workspace, cleanup } = setupTmp();
  const sessionId = "test_undo_conflict_" + Date.now();
  try {
    const filePath = "conflict.txt";
    const absPath = path.join(workspace, filePath);
    fs.writeFileSync(absPath, "version 1", "utf8");

    const ctx = {
      workspace,
      sessionId,
      turn: 1,
      autoApproveCommands: true,
      autoApproveEdits: true,
      approve: async () => true,
    };

    await callTool("write_file", { path: filePath, content: "version 2" }, ctx);

    // Simulate external edit by user
    fs.writeFileSync(absPath, "external user edit", "utf8");

    // Attempt undo
    const res = await undoLastTurn(sessionId, workspace);
    assert.equal(res.ok, false);
    assert.equal(res.conflict, true);
    assert.ok(res.message.includes("Conflict"));
    assert.equal(fs.readFileSync(absPath, "utf8"), "external user edit", "file should remain untouched on conflict");
  } finally {
    cleanup();
    fs.rmSync(path.join(UNDO_DIR, `${sessionId}.jsonl`), { force: true });
    fs.rmSync(path.join(UNDO_DIR, `${sessionId}.redo.jsonl`), { force: true });
  }
});

test("redo after undo restores the modified content", async () => {
  const { workspace, cleanup } = setupTmp();
  const sessionId = "test_undo_redo_" + Date.now();
  try {
    const filePath = "redo_test.txt";
    const absPath = path.join(workspace, filePath);
    fs.writeFileSync(absPath, "orig", "utf8");

    const ctx = {
      workspace,
      sessionId,
      turn: 1,
      autoApproveCommands: true,
      autoApproveEdits: true,
      approve: async () => true,
    };

    await callTool("write_file", { path: filePath, content: "modified" }, ctx);
    assert.equal(fs.readFileSync(absPath, "utf8"), "modified");

    // 1. Undo
    const undoRes = await undoLastTurn(sessionId, workspace);
    assert.equal(undoRes.ok, true);
    assert.equal(fs.readFileSync(absPath, "utf8"), "orig");

    // 2. Redo
    const redoRes = await redoLastTurn(sessionId, workspace);
    assert.equal(redoRes.ok, true);
    assert.deepEqual(redoRes.reapplied, [filePath]);
    assert.equal(fs.readFileSync(absPath, "utf8"), "modified");
  } finally {
    cleanup();
    fs.rmSync(path.join(UNDO_DIR, `${sessionId}.jsonl`), { force: true });
    fs.rmSync(path.join(UNDO_DIR, `${sessionId}.redo.jsonl`), { force: true });
  }
});

test("undo across multiple consecutive turns rolls back turn-by-turn", async () => {
  const { workspace, cleanup } = setupTmp();
  const sessionId = "test_multi_turn_" + Date.now();
  try {
    const fileA = "fileA.txt";
    const fileB = "fileB.txt";
    const absA = path.join(workspace, fileA);
    const absB = path.join(workspace, fileB);

    // Turn 1: create fileA
    const ctx1 = {
      workspace,
      sessionId,
      turn: 1,
      autoApproveCommands: true,
      autoApproveEdits: true,
      approve: async () => true,
    };
    await callTool("write_file", { path: fileA, content: "fileA turn 1" }, ctx1);

    // Turn 2: edit fileA, create fileB
    const ctx2 = {
      workspace,
      sessionId,
      turn: 2,
      autoApproveCommands: true,
      autoApproveEdits: true,
      approve: async () => true,
    };
    await callTool("write_file", { path: fileA, content: "fileA turn 2" }, ctx2);
    await callTool("write_file", { path: fileB, content: "fileB turn 2" }, ctx2);

    assert.equal(fs.readFileSync(absA, "utf8"), "fileA turn 2");
    assert.equal(fs.readFileSync(absB, "utf8"), "fileB turn 2");

    // 1st Undo -> rolls back Turn 2
    const res1 = await undoLastTurn(sessionId, workspace);
    assert.equal(res1.ok, true);
    assert.equal(res1.turn, 2);
    assert.equal(fs.readFileSync(absA, "utf8"), "fileA turn 1");
    assert.equal(fs.existsSync(absB), false);

    // 2nd Undo -> rolls back Turn 1
    const res2 = await undoLastTurn(sessionId, workspace);
    assert.equal(res2.ok, true);
    assert.equal(res2.turn, 1);
    assert.equal(fs.existsSync(absA), false);

    // 3rd Undo -> nothing left
    const res3 = await undoLastTurn(sessionId, workspace);
    assert.equal(res3.ok, false);
    assert.equal(res3.message, "Nothing to undo");
  } finally {
    cleanup();
    fs.rmSync(path.join(UNDO_DIR, `${sessionId}.jsonl`), { force: true });
    fs.rmSync(path.join(UNDO_DIR, `${sessionId}.redo.jsonl`), { force: true });
  }
});
