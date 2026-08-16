/**
 * Diagnostics after a write, and the tool sets each kind of agent gets.
 *
 * Both are safety properties in different senses. Diagnostics decide whether the
 * agent finds out that the code it just wrote does not parse - without them it
 * reports success and moves on. Tool sets decide what plan mode actually means: if
 * a write tool is still reachable there, the UI has been lying about it.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "tca-verify-"));
process.env.TCA_HOME = path.join(TMP, "state");
process.env.TCA_CONFIG = path.join(TMP, "config.json");
const WS = path.join(TMP, "ws");
fs.mkdirSync(WS, { recursive: true });

const { diagnose, formatDiagnoses } = await import("../src/diagnostics.js");
const { callTool, toolSpecs, TOOLS } = await import("../src/tools.js");

const ctx = (extra = {}) => ({
  workspace: WS,
  autoApproveCommands: true,
  approve: async () => true,
  ...extra,
});

const names = (opts) => toolSpecs(opts).map((s) => s.name);

/* ------------------------------------------------------------- diagnostics */

test("node --check catches a syntax error and passes valid code", async () => {
  fs.writeFileSync(path.join(WS, "broken.mjs"), "export function f( {\n");
  const bad = await diagnose({ workspace: WS, files: ["broken.mjs"] });
  assert.equal(bad.length, 1);
  assert.equal(bad[0].ok, false);
  assert.match(bad[0].checker, /node/);
  assert.match(bad[0].report, /broken\.mjs/);

  fs.writeFileSync(path.join(WS, "fine.mjs"), "export const f = () => 1;\n");
  const good = await diagnose({ workspace: WS, files: ["fine.mjs"] });
  assert.equal(good.length, 1);
  assert.equal(good[0].ok, true);
});

test("JSON is checked in process, with the parser's own message", async () => {
  fs.writeFileSync(path.join(WS, "bad.json"), '{"a": 1,}');
  const [d] = await diagnose({ workspace: WS, files: ["bad.json"] });
  assert.equal(d.ok, false);
  assert.equal(d.checker, "JSON parse");
  assert.match(d.report, /bad\.json/);
});

test("a file type with no checker here is reported as nothing, not as clean", async () => {
  fs.writeFileSync(path.join(WS, "notes.md"), "# hi\n");
  assert.deepEqual(await diagnose({ workspace: WS, files: ["notes.md"] }), []);
  // And a file that no longer exists is not an error either.
  assert.deepEqual(await diagnose({ workspace: WS, files: ["gone.js"] }), []);
});

test("tsc is skipped when the project has no tsconfig", async () => {
  fs.writeFileSync(path.join(WS, "loose.ts"), "const x: number = 'no';\n");
  // Checking a stray .ts file under defaults nobody chose would report errors
  // that are not real for this project.
  assert.deepEqual(await diagnose({ workspace: WS, files: ["loose.ts"] }), []);
});

test("formatDiagnoses frames the result as a check that ran", () => {
  assert.equal(formatDiagnoses([]), "");
  const text = formatDiagnoses([
    { checker: "node --check", ok: false, report: "SyntaxError: bad" },
    { checker: "JSON parse", ok: true, report: "" },
  ]);
  assert.match(text, /checked after this change/);
  assert.match(text, /✗ node --check/);
  assert.match(text, /✓ JSON parse/);
});

/* -------------------------------------------------- diagnostics on the edit */

test("a write that breaks the file says so in the tool result", async () => {
  const first = await callTool(
    "write_file",
    { path: "app.mjs", content: "export const ok = 1;\n" },
    ctx(),
  );
  assert.equal(first.ok, true, first.output);
  assert.match(first.output, /node --check/);

  const broken = await callTool(
    "edit_file",
    { path: "app.mjs", old_string: "export const ok = 1;", new_string: "export const ok = ;" },
    ctx(),
  );
  // The edit itself succeeded - the file was written. What matters is that the
  // model is told the result does not parse, in the same message.
  assert.equal(broken.ok, true);
  assert.match(broken.output, /checked after this change/);
  assert.match(broken.output, /✗/);
});

test("verifyEdits false turns the whole thing off", async () => {
  const r = await callTool(
    "write_file",
    { path: "unchecked.mjs", content: "const = ;\n" },
    ctx({ verifyEdits: false }),
  );
  assert.equal(r.ok, true);
  assert.doesNotMatch(r.output, /checked after this change/);
});

test("the verify tool checks on demand and refuses to leave the workspace", async () => {
  fs.writeFileSync(path.join(WS, "vfy.mjs"), "const a = (;\n");
  const r = await callTool("verify", { paths: ["vfy.mjs"] }, ctx());
  assert.equal(r.ok, true);
  assert.match(r.output, /node --check/);

  const escape = await callTool("verify", { paths: ["../outside.mjs"] }, ctx());
  assert.equal(escape.ok, false);
  assert.match(escape.output, /escapes the workspace/);
});

/* ---------------------------------------------------------------- tool sets */

test("build mode offers everything, including sub-agents", () => {
  const build = names({ mode: "build", kind: "root" });
  assert.deepEqual(build, Object.keys(TOOLS), "every tool should be offered to the root build agent");
  assert.ok(build.includes("task"));
  assert.ok(build.includes("write_file"));
});

test("plan mode withholds every file-writing tool but keeps git usable", () => {
  const plan = names({ mode: "plan", kind: "root" });
  for (const w of ["write_file", "edit_file", "patch_file", "move_file", "delete_file"]) {
    assert.ok(!plan.includes(w), `${w} must not be offered in plan mode`);
  }
  // Reading a repository properly needs git log and git diff, so the shell stays -
  // it just can never be auto-approved. See run_command in tools.js.
  assert.ok(plan.includes("run_command"));
  assert.ok(plan.includes("read_file"));
  assert.ok(plan.includes("grep"));
  // Investigating a codebase is exactly what plan mode is for, so delegation has
  // to survive it. An explore sub-agent is read-only, and the task tool refuses a
  // writing one in this mode.
  assert.ok(plan.includes("task"), "plan mode is when you most want to delegate reading");
});

test("an explore sub-agent is read-only and cannot spawn more sub-agents", () => {
  const explore = names({ mode: "build", kind: "explore" });
  assert.ok(!explore.includes("write_file"));
  assert.ok(!explore.includes("task"), "unbounded fan-out of paid API calls");
  assert.ok(explore.includes("read_file"));
  assert.ok(explore.includes("web_search"));
});

test("a general sub-agent may write, but still cannot delegate further", () => {
  const general = names({ mode: "build", kind: "general" });
  assert.ok(general.includes("write_file"));
  assert.ok(!general.includes("task"));
});

test("plan mode blocks a write even if the model remembers the tool", async () => {
  // The spec is withheld, but a model that saw write_file earlier in the
  // conversation can still ask for it. That has to fail at the call, not succeed.
  const r = await callTool("write_file", { path: "sneaky.txt", content: "x" }, ctx({ mode: "plan" }));
  assert.equal(r.ok, false);
  assert.match(r.output, /plan mode is read-only/);
  assert.equal(fs.existsSync(path.join(WS, "sneaky.txt")), false);
});

test("plan mode asks before every command, even with auto-approve on", async () => {
  /** @type {any[]} */
  const asked = [];
  const r = await callTool(
    "run_command",
    { command: "echo hello" },
    ctx({
      autoApproveCommands: true,
      mode: "plan",
      approve: async (req) => {
        asked.push(req);
        return true;
      },
    }),
  );
  assert.equal(r.ok, true, r.output);
  assert.equal(asked.length, 1);
  assert.match(asked[0].reason, /plan mode/);
});

test("the task tool refuses a prompt too thin to work from", async () => {
  const thin = await callTool("task", { description: "look", prompt: "check" }, ctx({ spawnAgent: async () => "x" }));
  assert.equal(thin.ok, false);
  assert.match(thin.output, /cannot ask you for more/);

  const noAgent = await callTool(
    "task",
    { description: "look", prompt: "find where sessions are persisted and report the path" },
    ctx(),
  );
  assert.equal(noAgent.ok, false);
  assert.match(noAgent.output, /not available/);
});

test("the task tool passes the prompt through and returns only the answer", async () => {
  /** @type {any[]} */
  const spawned = [];
  const r = await callTool(
    "task",
    { description: "find it", prompt: "find where sessions are persisted", kind: "explore" },
    ctx({
      spawnAgent: async (args) => {
        spawned.push(args);
        return "src/store.js:19 - one JSONL file per session";
      },
    }),
  );
  assert.equal(r.ok, true, r.output);
  assert.equal(r.output, "src/store.js:19 - one JSONL file per session");
  assert.deepEqual(spawned, [{ prompt: "find where sessions are persisted", kind: "explore" }]);
});

test("plan mode will not run a writing sub-agent", async () => {
  const r = await callTool(
    "task",
    { description: "do it", prompt: "rename the config module everywhere", kind: "general" },
    ctx({ mode: "plan", spawnAgent: async () => "done" }),
  );
  assert.equal(r.ok, false);
  assert.match(r.output, /plan mode is read-only/);
});

test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));
