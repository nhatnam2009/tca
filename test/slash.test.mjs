import test from "node:test";
import assert from "node:assert/strict";
import {
  parseSlashCommand,
  listSlashCommands,
  findSlashCommand,
  resolveSlashPrompt,
  BUILTIN_COMMANDS,
} from "../src/slash.js";

test("parseSlashCommand parses slash commands and arguments", () => {
  assert.deepEqual(parseSlashCommand("/help"), {
    isSlash: true,
    name: "help",
    args: "",
    raw: "/help",
  });

  assert.deepEqual(parseSlashCommand("/review src/tools.js --detailed"), {
    isSlash: true,
    name: "review",
    args: "src/tools.js --detailed",
    raw: "/review src/tools.js --detailed",
  });

  assert.deepEqual(parseSlashCommand("not a /slash command"), {
    isSlash: false,
    raw: "not a /slash command",
  });

  assert.deepEqual(parseSlashCommand(""), {
    isSlash: false,
    raw: "",
  });
});

test("listSlashCommands returns built-ins and custom agents", () => {
  const config = {
    customAgents: {
      reviewer: {
        name: "Security Reviewer",
        description: "Scans code for security vulnerabilities",
        systemPrompt: "Check for OWASP top 10 vulnerabilities",
        mode: "plan",
      },
    },
  };

  const list = listSlashCommands(config);
  assert.ok(list.length >= BUILTIN_COMMANDS.length + 1);

  const foundBuiltin = list.find((c) => c.name === "review");
  assert.ok(foundBuiltin);
  assert.equal(foundBuiltin.kind, "builtin");

  const foundCustom = list.find((c) => c.name === "reviewer");
  assert.ok(foundCustom);
  assert.equal(foundCustom.kind, "custom");
  assert.equal(foundCustom.description, "Scans code for security vulnerabilities");
});

test("findSlashCommand retrieves commands case-insensitively", () => {
  const config = {
    customAgents: {
      tester: {
        description: "Write unit tests",
        systemPrompt: "Generate node:test suites",
        mode: "build",
      },
    },
  };

  const c1 = findSlashCommand("REVIEW", config);
  assert.ok(c1);
  assert.equal(c1.name, "review");

  const c2 = findSlashCommand("TESTER", config);
  assert.ok(c2);
  assert.equal(c2.name, "tester");
  assert.equal(c2.kind, "custom");

  const c3 = findSlashCommand("nonexistent", config);
  assert.equal(c3, null);
});

test("resolveSlashPrompt handles local commands and prompt generation", () => {
  const config = {
    customAgents: {
      refactor: {
        description: "Code refactor specialist",
        systemPrompt: "You refactor code for readability and performance.",
        mode: "build",
      },
    },
  };

  // /help local action
  const helpRes = resolveSlashPrompt("/help", config);
  assert.equal(helpRes.handledLocally, true);
  assert.equal(helpRes.localAction, "help");
  assert.ok(helpRes.localResult.includes("/review"));

  // /undo local action
  const undoRes = resolveSlashPrompt("/undo", config);
  assert.equal(undoRes.handledLocally, true);
  assert.equal(undoRes.localAction, "undo");

  // /review with custom prompt
  const reviewWithArgs = resolveSlashPrompt("/review check memory leaks", config);
  assert.equal(reviewWithArgs.prompt, "check memory leaks");
  assert.equal(reviewWithArgs.mode, "plan");
  assert.ok(reviewWithArgs.extraInstructions.includes("expert code reviewer"));

  // /review with default fallback prompt
  const reviewDefault = resolveSlashPrompt("/review", config);
  assert.ok(reviewDefault.prompt.includes("review recent code changes"));
  assert.equal(reviewDefault.mode, "plan");

  // custom agent resolution
  const customRes = resolveSlashPrompt("/refactor improve loops", config);
  assert.equal(customRes.prompt, "improve loops");
  assert.equal(customRes.mode, "build");
  assert.equal(customRes.extraInstructions, "You refactor code for readability and performance.");
});
