import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultConfig, loadConfig } from "../src/config.js";
import { callTool, checkPermission } from "../src/tools.js";

function setupTmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tca-perm-test-"));
  return {
    workspace: dir,
    cleanup: () => {
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("defaultConfig includes default granular permissions", () => {
  const cfg = defaultConfig();
  assert.deepEqual(cfg.permissions, {
    bash: "ask",
    file_write: "allow",
    file_read: "allow",
    web_search: "allow",
    subagent: "allow",
    git: "allow",
  });
});

test("backward compatibility infers permissions from legacy booleans", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tca-cfg-test-"));
  const configFile = path.join(tmp, "config.json");
  try {
    process.env.TCA_CONFIG = configFile;
    // Legacy config with autoApproveCommands: true and autoApproveEdits: false
    fs.writeFileSync(
      configFile,
      JSON.stringify({
        active: "test",
        workspace: tmp,
        autoApproveCommands: true,
        autoApproveEdits: false,
      }),
      "utf8",
    );

    const { config } = loadConfig();
    assert.equal(config.permissions.bash, "allow");
    assert.equal(config.permissions.git, "allow");
    assert.equal(config.permissions.file_write, "ask");
    assert.equal(config.permissions.file_read, "allow");
  } finally {
    delete process.env.TCA_CONFIG;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("checkPermission identifies categories correctly", () => {
  const ctx = {
    permissions: {
      bash: "ask",
      git: "allow",
      file_write: "deny",
      file_read: "allow",
      web_search: "deny",
      subagent: "ask",
    },
  };

  assert.equal(checkPermission("run_command", { command: "git status" }, ctx), "allow");
  assert.equal(checkPermission("run_command", { command: "npm test" }, ctx), "ask");
  assert.equal(checkPermission("write_file", { path: "a.txt" }, ctx), "deny");
  assert.equal(checkPermission("edit_file", { path: "a.txt" }, ctx), "deny");
  assert.equal(checkPermission("read_file", { path: "a.txt" }, ctx), "allow");
  assert.equal(checkPermission("web_search", { query: "test" }, ctx), "deny");
  assert.equal(checkPermission("task", { prompt: "do work" }, ctx), "ask");
});

test("callTool blocks execution when tool category is denied", async () => {
  const { workspace, cleanup } = setupTmp();
  try {
    const ctx = {
      workspace,
      permissions: {
        file_write: "deny",
        bash: "deny",
        web_search: "deny",
      },
      approve: async () => true,
    };

    const writeRes = await callTool("write_file", { path: "test.txt", content: "hello" }, ctx);
    assert.equal(writeRes.ok, false);
    assert.ok(writeRes.output.includes("denied by configuration"));
    assert.equal(fs.existsSync(path.join(workspace, "test.txt")), false);

    const cmdRes = await callTool("run_command", { command: "echo hi" }, ctx);
    assert.equal(cmdRes.ok, false);
    assert.ok(cmdRes.output.includes("denied by configuration"));

    const searchRes = await callTool("web_search", { query: "test" }, ctx);
    assert.equal(searchRes.ok, false);
    assert.ok(searchRes.output.includes("denied by configuration"));
  } finally {
    cleanup();
  }
});

test("callTool triggers approval request when category is set to ask", async () => {
  const { workspace, cleanup } = setupTmp();
  try {
    let requested = null;
    const ctx = {
      workspace,
      permissions: {
        bash: "ask",
        file_write: "ask",
      },
      approve: async (req) => {
        requested = req;
        return true;
      },
    };

    const res = await callTool("write_file", { path: "approved.txt", content: "saved" }, ctx);
    assert.equal(res.ok, true);
    assert.ok(requested);
    assert.equal(requested.kind, "edit");
    assert.equal(fs.readFileSync(path.join(workspace, "approved.txt"), "utf8"), "saved");

    // Deny flow
    ctx.approve = async () => false;
    const deniedRes = await callTool("write_file", { path: "denied.txt", content: "nope" }, ctx);
    assert.equal(deniedRes.ok, false);
    assert.ok(deniedRes.output.includes("user denied"));
    assert.equal(fs.existsSync(path.join(workspace, "denied.txt")), false);
  } finally {
    cleanup();
  }
});

test("callTool allows execution directly when category is set to allow", async () => {
  const { workspace, cleanup } = setupTmp();
  try {
    let asked = false;
    const ctx = {
      workspace,
      permissions: {
        bash: "allow",
        git: "allow",
        file_write: "allow",
        file_read: "allow",
      },
      approve: async () => {
        asked = true;
        return true;
      },
    };

    const res = await callTool("write_file", { path: "direct.txt", content: "direct write" }, ctx);
    assert.equal(res.ok, true);
    assert.equal(asked, false, "should not prompt for approval when allow");
    assert.equal(fs.readFileSync(path.join(workspace, "direct.txt"), "utf8"), "direct write");
  } finally {
    cleanup();
  }
});
