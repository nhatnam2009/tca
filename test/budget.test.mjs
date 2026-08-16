import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultConfig, loadConfig } from "../src/config.js";
import { Agent } from "../src/loop.js";

function fakeProvider(turns) {
  let turn = 0;
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      requests.push(JSON.parse(body || "{}"));
      const chunks = turns[Math.min(turn++, turns.length - 1)];
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  return { server, requests, turnsServed: () => turn };
}

const listen = (server) =>
  new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));

test("defaultConfig includes default budget limits", () => {
  const cfg = defaultConfig();
  assert.deepEqual(cfg.budget, {
    maxCostPerSession: 0,
    maxTokensPerSession: 0,
    warnAtPercent: 80,
  });
});

test("Agent stops when session cost limit is reached", async () => {
  const turns = [
    [
      { choices: [{ index: 0, delta: { content: "Thinking..." } }] },
      {
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 100000, completion_tokens: 10000 },
      },
    ],
  ];
  const { server } = fakeProvider(turns);
  const port = await listen(server);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tca-budget-cost-"));

  try {
    const config = {
      active: "openai",
      workspace: dir,
      autoApproveCommands: true,
      autoApproveEdits: true,
      budget: {
        maxCostPerSession: 0.05, // very low limit
        maxTokensPerSession: 0,
        warnAtPercent: 80,
      },
      providers: {
        openai: {
          kind: "openai",
          baseUrl: `http://127.0.0.1:${port}/v1`,
          apiKey: "test-key",
          model: "gpt-5.6",
        },
      },
    };

    const events = [];
    const agent = new Agent({
      config,
      sessionId: "session_budget_cost_" + Date.now(),
      emit: (ev) => events.push(ev),
    });

    await agent.run("Do some work");

    const exceeded = events.find((e) => e.type === "budget_exceeded");
    assert.ok(exceeded, "should emit budget_exceeded event");
    assert.equal(exceeded.kind, "cost");

    const errors = events.filter((e) => e.type === "error");
    assert.ok(errors.some((e) => e.message.includes("cost limit")), "should emit cost limit error message");
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Agent stops when maxTokensPerSession is reached", async () => {
  const turns = [
    [
      { choices: [{ index: 0, delta: { content: "Doing work..." } }] },
      {
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 500, completion_tokens: 600 },
      },
    ],
  ];
  const { server } = fakeProvider(turns);
  const port = await listen(server);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tca-budget-tokens-"));

  try {
    const config = {
      active: "test",
      workspace: dir,
      autoApproveCommands: true,
      autoApproveEdits: true,
      budget: {
        maxCostPerSession: 0,
        maxTokensPerSession: 1000,
        warnAtPercent: 50,
      },
      providers: {
        test: {
          kind: "openai",
          baseUrl: `http://127.0.0.1:${port}/v1`,
          apiKey: "test-key",
          model: "gpt-4o-mini",
        },
      },
    };

    const events = [];
    const agent = new Agent({
      config,
      sessionId: "session_budget_tokens_" + Date.now(),
      emit: (ev) => events.push(ev),
    });

    await agent.run("Do token work");

    const warning = events.find((e) => e.type === "budget_warning");
    assert.ok(warning, "should emit budget_warning when past warnAtPercent");
    assert.equal(warning.kind, "tokens");

    const exceeded = events.find((e) => e.type === "budget_exceeded");
    assert.ok(exceeded, "should emit budget_exceeded when past maxTokens");
    assert.equal(exceeded.kind, "tokens");
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Agent runs unconstrained when budget is 0 (unlimited)", async () => {
  const turns = [
    [
      { choices: [{ index: 0, delta: { content: "Unlimited response" } }] },
      {
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 1000, completion_tokens: 500 },
      },
    ],
  ];
  const { server } = fakeProvider(turns);
  const port = await listen(server);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tca-budget-unlimited-"));

  try {
    const config = {
      active: "test",
      workspace: dir,
      autoApproveCommands: true,
      autoApproveEdits: true,
      budget: {
        maxCostPerSession: 0,
        maxTokensPerSession: 0,
        warnAtPercent: 80,
      },
      providers: {
        test: {
          kind: "openai",
          baseUrl: `http://127.0.0.1:${port}/v1`,
          apiKey: "test-key",
          model: "gpt-4o-mini",
        },
      },
    };

    const events = [];
    const agent = new Agent({
      config,
      sessionId: "session_budget_unlimited_" + Date.now(),
      emit: (ev) => events.push(ev),
    });

    const res = await agent.run("Hello");
    assert.equal(res, "Unlimited response");

    const exceeded = events.find((e) => e.type === "budget_exceeded");
    assert.equal(exceeded, undefined, "should NOT emit budget_exceeded");
    const warning = events.find((e) => e.type === "budget_warning");
    assert.equal(warning, undefined, "should NOT emit budget_warning");
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
