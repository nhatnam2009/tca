/**
 * The native search fast path, the plan tool, and AGENTS.md.
 *
 * The important test here is parity. grep and glob both run through ripgrep
 * when the device has them, so the agent's behaviour must not depend on which
 * packages happen to be installed - the same search has to return the same
 * answer either way. TCA_NO_FASTSEARCH exists so this can be checked by running
 * each search twice on the same fixture.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "tca-search-"));
const WORKSPACE = path.join(TMP, "workspace");
fs.mkdirSync(WORKSPACE, { recursive: true });
process.env.TCA_HOME = path.join(TMP, "state");
process.env.TCA_CONFIG = path.join(TMP, "config.json");

const { callTool, IGNORE_DIRS: IGNORED } = await import("../src/tools.js");
const { have, needsJsRegex, rgSearch, rgGlob, resetProbes } = await import("../src/fastsearch.js");
const { readTodos } = await import("../src/store.js");
const { notify, clearNotification, vibrate, resetNotifyProbe } = await import("../src/notify.js");

const ctx = () => ({ workspace: WORKSPACE, autoApproveCommands: true, approve: async () => true });

/** A tree with enough shape to catch an ignore-rule or depth mismatch. */
function buildFixture() {
  const write = (rel, body) => {
    const abs = path.join(WORKSPACE, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  };
  write("top.js", "const needle = 1;\nconst other = 2;\nneedle again\n");
  write("src/deep/a.js", "// needle in a comment\nfunction f() {}\n");
  write("src/deep/b.ts", "let needle: number;\n");
  write("src/notes.md", "needle in markdown\n");
  write(".hidden.js", "needle hidden\n"); // our walk does not skip dotfiles
  write("no-match.js", "nothing here\n");
  // Both implementations must skip these, for the same reason.
  write("node_modules/pkg/index.js", "needle in a dependency\n");
  write(".git/objects/x", "needle in git internals\n");
  write("dist/bundle.js", "needle in a build artefact\n");
  // A .gitignore must NOT change the answer: the JavaScript walk never reads one,
  // so ripgrep is told not to either.
  write(".gitignore", "no-match.js\nsrc/notes.md\n");
}
buildFixture();

/** Run a tool with the fast path forced off. */
async function slow(name, input) {
  process.env.TCA_NO_FASTSEARCH = "1";
  resetProbes();
  try {
    return await callTool(name, input, ctx());
  } finally {
    delete process.env.TCA_NO_FASTSEARCH;
    resetProbes();
  }
}

async function fast(name, input) {
  delete process.env.TCA_NO_FASTSEARCH;
  resetProbes();
  return callTool(name, input, ctx());
}

/* ------------------------------------------------------------------ parity */

test("ripgrep and the JavaScript walk answer identically", async (t) => {
  if (!(await have("rg"))) {
    t.skip("ripgrep is not installed here, so there is nothing to compare against");
    return;
  }

  for (const input of [
    { pattern: "needle" },
    { pattern: "needle", include: "*.js" },
    { pattern: "needle", include: "src/**/*.ts" },
    { pattern: "^needle" },
    { pattern: "needle$" },
    { pattern: "n[ee]+dle" },
    { pattern: "\\bneedle\\b" },
    { pattern: "definitely-not-present" },
    { pattern: "needle", path: "src" },
  ]) {
    const a = await fast("grep", input);
    const b = await slow("grep", input);
    assert.equal(a.ok, b.ok, `ok differs for ${JSON.stringify(input)}`);
    assert.equal(
      a.output,
      b.output,
      `ripgrep and JavaScript disagree for ${JSON.stringify(input)}\n--- rg ---\n${a.output}\n--- js ---\n${b.output}`,
    );
  }
});

test("both paths skip the same directories, and neither reads .gitignore", async (t) => {
  if (!(await have("rg"))) {
    t.skip("ripgrep is not installed here");
    return;
  }
  const res = await fast("grep", { pattern: "needle" });
  assert.equal(res.ok, true, res.output);

  // Ignored directories, in both implementations, by our own fixed list.
  for (const gone of ["node_modules", ".git/", "dist/"]) {
    assert.ok(!res.output.includes(gone), `${gone} should not be searched`);
  }
  // ripgrep would skip these by default; it must not, because our walk does not.
  assert.match(res.output, /\.hidden\.js/, "dotfiles are searched");
  assert.match(res.output, /src\/notes\.md/, "a gitignored file is still searched");
});

test("a pattern ripgrep cannot express goes to JavaScript instead of answering wrongly", async () => {
  // The Rust regex crate has no lookaround. Silently matching differently would
  // be far worse than being slower.
  assert.equal(needsJsRegex("needle(?= again)"), true);
  assert.equal(needsJsRegex("(?!not)needle"), true);
  assert.equal(needsJsRegex("(?<=const )needle"), true);
  assert.equal(needsJsRegex("(a)\\1"), true);
  assert.equal(needsJsRegex("\\bneedle\\b"), false);
  assert.equal(needsJsRegex("^needle$"), false);

  const res = await fast("grep", { pattern: "needle(?= again)" });
  assert.equal(res.ok, true, res.output);
  assert.match(res.output, /top\.js:3/, "lookahead still has to work, just on the slow path");
});

test("results are sorted, so truncation cuts the same list on both paths", async () => {
  const res = await fast("grep", { pattern: "needle" });
  const files = res.output.split("\n").filter((l) => l.includes(":")).map((l) => l.split(":")[0]);
  assert.deepEqual(files, files.slice().sort(), "output must be ordered by path");

  const capped = await fast("grep", { pattern: "needle", max_results: 2 });
  const lines = capped.output.split("\n");
  assert.equal(lines.filter((l) => /:\d+:/.test(l)).length, 2);
  assert.match(capped.output, /more match\(es\)/, "it has to say the list was cut");
});

test("glob agrees between ripgrep and the JavaScript walk, on every pattern shape", async (t) => {
  // Glob used to go through fd, and fd disagreed with the walk in three separate
  // ways, every one of which surfaced as "no files match" - indistinguishable from
  // a real empty result, so nothing fell back and the agent was told the file it
  // was looking for did not exist. See rgGlob in src/fastsearch.js.
  //
  // The three shapes below are exactly the three that broke, so they are checked
  // together rather than one representative being trusted to stand for the rest.
  for (const pattern of ["*.js", "**/*.js", "src/*.js", "src/**/*.js", "*.ts", "**/*.md"]) {
    const a = await fast("glob", { pattern });
    const b = await slow("glob", { pattern });
    assert.equal(a.ok, true, a.output);
    assert.equal(
      a.output,
      b.output,
      `ripgrep and JavaScript disagree for ${pattern}\n--- rg ---\n${a.output}\n--- js ---\n${b.output}`,
    );
  }

  // And the semantics themselves, so "they agree" cannot mean "both are wrong".
  const top = await fast("glob", { pattern: "*.js" });
  assert.match(top.output, /top\.js/);
  assert.ok(!top.output.includes("src/deep/a.js"), "a slash-free glob stays in the current directory");

  const deep = await fast("glob", { pattern: "**/*.js" });
  assert.match(deep.output, /src\/deep\/a\.js/, "** has to cross directories");
  assert.ok(!deep.output.includes("node_modules"), "ignored directories stay ignored");

  if (!(await have("rg"))) t.diagnostic("ripgrep is not installed here; only the JavaScript path ran");
});

test("a glob is answered from ripgrep only when ripgrep is there", async (t) => {
  if (!(await have("rg"))) {
    t.skip("ripgrep is not installed here");
    return;
  }
  const res = await rgGlob({
    root: WORKSPACE,
    pattern: "*.js",
    limit: 50,
    ignoreDirs: IGNORED,
  });
  assert.equal(res.ok, true, res.ok ? "" : res.reason);
  assert.ok(res.files.includes("top.js"), `expected top.js in ${JSON.stringify(res.files)}`);
  assert.ok(
    !res.files.some((f) => f.startsWith("node_modules/")),
    "the exclusions have to actually exclude",
  );
  assert.deepEqual(res.files, res.files.slice().sort(), "sorted, so the limit cuts the same set as the walk");
});

test("a glob matching nothing is an answer, and a broken run is a fallback", async () => {
  const empty = await rgGlob({ root: WORKSPACE, pattern: "*.nothing", limit: 10, ignoreDirs: IGNORED });
  if (await have("rg")) {
    assert.equal(empty.ok, true, "no matches is an answer, not a failure");
    assert.deepEqual(empty.files, []);
  }

  // A root that does not exist must fall back rather than report zero files: an
  // empty answer here would be a lie the caller cannot detect.
  const broken = await rgGlob({
    root: path.join(WORKSPACE, "does-not-exist-anywhere"),
    pattern: "*.js",
    limit: 10,
    ignoreDirs: [],
  });
  assert.equal(broken.ok, false);
  assert.ok(broken.reason);
});

test("a missing binary is not an error, just the slower path", async () => {
  resetProbes();
  process.env.TCA_NO_FASTSEARCH = "1";
  try {
    const rg = await rgSearch({
      root: WORKSPACE,
      pattern: "needle",
      maxResults: 10,
      maxFileSize: 1000,
      ignoreDirs: [],
    });
    assert.equal(rg.ok, false);
    assert.ok(rg.reason, "the caller should be able to say why it fell back");

    const glob = await rgGlob({ root: WORKSPACE, pattern: "*.js", limit: 10, ignoreDirs: [] });
    assert.equal(glob.ok, false);
    assert.ok(glob.reason);
  } finally {
    delete process.env.TCA_NO_FASTSEARCH;
    resetProbes();
  }
});

/* -------------------------------------------------------------------- plan */

test("todo_write stores the plan, renders it, and reports progress", async () => {
  const seen = [];
  const c = { ...ctx(), sessionId: "sess-plan", onTodo: (items) => seen.push(items) };

  const first = await callTool(
    "todo_write",
    {
      items: [
        { text: "read the file", status: "done" },
        { text: "make the change", status: "in_progress" },
        { text: "run the tests", status: "pending" },
      ],
    },
    c,
  );
  assert.equal(first.ok, true, first.output);
  assert.match(first.output, /1\/3 done/);
  assert.match(first.output, /\[x\] read the file/);
  assert.match(first.output, /\[>\] make the change/);
  assert.match(first.output, /\[ \] run the tests/);

  // The UI is told directly: a plan the user cannot see is only half useful.
  assert.equal(seen.length, 1);
  assert.equal(seen[0][1].status, "in_progress");

  // And it survives the turn, so compaction cannot lose it.
  assert.deepEqual(
    readTodos("sess-plan").map((x) => x.status),
    ["done", "in_progress", "pending"],
  );

  // Rewriting replaces rather than appends: no id bookkeeping to drift.
  const second = await callTool(
    "todo_write",
    { items: [{ text: "only this now", status: "done" }] },
    c,
  );
  assert.match(second.output, /1\/1 done/);
  assert.deepEqual(readTodos("sess-plan"), [{ text: "only this now", status: "done" }]);
});

test("todo_write refuses a list that would stop meaning anything", async () => {
  const c = { ...ctx(), sessionId: "sess-bad" };

  // Two things "in progress" is the failure that makes a plan useless.
  const two = await callTool(
    "todo_write",
    {
      items: [
        { text: "a", status: "in_progress" },
        { text: "b", status: "in_progress" },
      ],
    },
    c,
  );
  assert.equal(two.ok, false);
  assert.match(two.output, /in_progress/);

  for (const [label, items] of [
    ["a bad status", [{ text: "a", status: "maybe" }]],
    ["empty text", [{ text: "   ", status: "pending" }]],
    ["not an array", "nope"],
  ]) {
    const res = await callTool("todo_write", { items }, c);
    assert.equal(res.ok, false, `${label} should be rejected`);
  }
  assert.deepEqual(readTodos("sess-bad"), [], "nothing invalid should have been stored");

  // Without a session there is nowhere to keep it; say so rather than throwing.
  const noSession = await callTool("todo_write", { items: [{ text: "a", status: "pending" }] }, ctx());
  assert.equal(noSession.ok, false);
  assert.match(noSession.output, /not available/);
});

/* -------------------------------------------------------------- AGENTS.md */

test("AGENTS.md in the workspace reaches the system prompt, and re-reading picks up edits", async () => {
  const { Runner } = await import("../src/loop.js");
  const file = path.join(WORKSPACE, "AGENTS.md");
  const config = {
    active: "x",
    providers: { x: { kind: "openai", baseUrl: "http://127.0.0.1:1", apiKey: "k", model: "m" } },
    workspace: WORKSPACE,
    autoApproveCommands: true,
  };
  const runner = new Runner({ sessionId: "sess-agents", config, emit: () => {} });

  // No file: nothing is added, and certainly no crash.
  fs.rmSync(file, { force: true });
  assert.ok(!runner.buildSystemPrompt().includes("Project instructions"));

  fs.writeFileSync(file, "Use tabs. Never touch generated/.\n");
  const withFile = runner.buildSystemPrompt();
  assert.match(withFile, /Project instructions/);
  assert.match(withFile, /Use tabs\./);
  assert.match(withFile, /take precedence/, "the model needs to know these win");

  // Read fresh every turn, so editing the file takes effect on the next message
  // instead of on the next restart.
  fs.writeFileSync(file, "Actually use spaces.\n");
  assert.match(runner.buildSystemPrompt(), /Actually use spaces\./);

  fs.rmSync(file, { force: true });
});

/* ---------------------------------------------------------- notifications */

test("notifications are silent when there is no Termux to notify through", async () => {
  resetNotifyProbe();
  const original = process.env.TERMUX_VERSION;
  delete process.env.TERMUX_VERSION;
  try {
    assert.equal(await notify({ title: "x" }), false);
    assert.equal(await clearNotification(), false);
    assert.equal(await vibrate(), false);
  } finally {
    if (original !== undefined) process.env.TERMUX_VERSION = original;
    resetNotifyProbe();
  }
});
