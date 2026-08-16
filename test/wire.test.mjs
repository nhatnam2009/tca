/**
 * The wire layer: what actually goes on the socket.
 *
 * These are the bugs a fake provider that accepts anything cannot catch. Both real
 * APIs reject requests this file is checking the shape of - strict role
 * alternation on Anthropic, tool_result ordering, thinking blocks that must be
 * replayed with their signature - and every one of those failures arrives as a
 * bare 400 with no clue which message caused it.
 */

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

const { stream } = await import("../src/provider.js");

/* -------------------------------------------------------------------- harness */

/** A server that records the request body and replays canned SSE chunks. */
async function fakeProvider(chunks) {
  /** @type {any[]} */
  const bodies = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      bodies.push({ url: req.url, headers: req.headers, body: JSON.parse(raw || "{}") });
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = /** @type {any} */ (server.address()).port;
  return { bodies, port, close: () => server.close() };
}

/** Run one turn and collect both the events and the request that produced it. */
async function roundTrip({ kind, messages, tools = [], chunks, provider = {} }) {
  const fake = await fakeProvider(chunks);
  try {
    const events = [];
    for await (const ev of stream({
      provider: {
        kind,
        baseUrl: `http://127.0.0.1:${fake.port}/v1`,
        apiKey: "test-key",
        model: "m",
        maxTokens: 1024,
        ...provider,
      },
      system: "be brief",
      messages,
      tools,
    })) {
      events.push(ev);
    }
    return { events, sent: fake.bodies[0] };
  } finally {
    fake.close();
  }
}

const anthropicDone = [
  { type: "message_start", message: { usage: { input_tokens: 100, cache_read_input_tokens: 80, cache_creation_input_tokens: 12 } } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } },
  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } },
];

const openaiDone = [
  { choices: [{ delta: { content: "hi" } }] },
  { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 9, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 7 } } },
];

/* ------------------------------------------------------------ prompt caching */

test("Anthropic gets cache breakpoints on the tools, the system prompt and the last two user turns", async () => {
  const tools = [
    { name: "read_file", description: "read", parameters: { type: "object" } },
    { name: "grep", description: "search", parameters: { type: "object" } },
  ];
  const messages = [
    { role: "user", content: "one" },
    { role: "assistant", content: "", toolCalls: [{ id: "a", name: "read_file", input: {} }] },
    { role: "tool", results: [{ id: "a", name: "read_file", output: "x", ok: true }] },
    { role: "assistant", content: "", toolCalls: [{ id: "b", name: "grep", input: {} }] },
    { role: "tool", results: [{ id: "b", name: "grep", output: "y", ok: true }] },
  ];
  const { sent } = await roundTrip({ kind: "anthropic", messages, tools, chunks: anthropicDone });

  // The system prompt and the tool list are the big fixed prefix.
  assert.deepEqual(sent.body.system[0].cache_control, { type: "ephemeral" });
  assert.equal(sent.body.tools[0].cache_control, undefined, "only the last tool carries the breakpoint");
  assert.deepEqual(sent.body.tools[1].cache_control, { type: "ephemeral" });

  // Two rolling breakpoints on the user side, so each turn re-reads the whole
  // conversation from cache instead of paying full price for it again.
  const marked = sent.body.messages
    .map((m, i) => (m.content.some((b) => b.cache_control) ? i : -1))
    .filter((i) => i >= 0);
  assert.equal(marked.length, 2, `expected 2 breakpoints, got ${marked.length}`);
  for (const i of marked) assert.equal(sent.body.messages[i].role, "user");
  // Exactly four in total: that is the Anthropic maximum.
  const total =
    1 +
    sent.body.tools.filter((x) => x.cache_control).length +
    sent.body.messages.reduce((n, m) => n + m.content.filter((b) => b.cache_control).length, 0);
  assert.equal(total, 4);
});

test("promptCache false sends a plain request", async () => {
  const { sent } = await roundTrip({
    kind: "anthropic",
    messages: [{ role: "user", content: "one" }],
    tools: [{ name: "t", description: "d", parameters: {} }],
    chunks: anthropicDone,
    provider: { promptCache: false },
  });
  assert.equal(typeof sent.body.system, "string");
  assert.equal(sent.body.tools[0].cache_control, undefined);
  assert.equal(JSON.stringify(sent.body).includes("cache_control"), false);
});

test("cache token counts come back so the UI can show what caching saved", async () => {
  const { events } = await roundTrip({
    kind: "anthropic",
    messages: [{ role: "user", content: "one" }],
    chunks: anthropicDone,
  });
  const usage = events.find((e) => e.type === "usage");
  assert.deepEqual(usage, { type: "usage", input: 100, output: 5, cacheRead: 80, cacheWrite: 12 });

  const openai = await roundTrip({
    kind: "openai",
    messages: [{ role: "user", content: "one" }],
    chunks: openaiDone,
  });
  const u2 = openai.events.find((e) => e.type === "usage");
  assert.equal(u2.cacheRead, 7);
});

/* ------------------------------------------------------- role alternation */

test("consecutive user-side messages are merged, with tool results first", async () => {
  // Both of these happen in practice: pressing Stop before the model replies
  // leaves two user messages, and stopping after the tools ran leaves a tool
  // message followed by the next user message. Anthropic rejects either.
  const messages = [
    { role: "user", content: "first" },
    { role: "user", content: "actually, this instead" },
    { role: "assistant", content: "", toolCalls: [{ id: "a", name: "t", input: {} }] },
    { role: "tool", results: [{ id: "a", name: "t", output: "out", ok: true }] },
    { role: "user", content: "and now this" },
  ];
  const { sent } = await roundTrip({ kind: "anthropic", messages, chunks: anthropicDone });

  const roles = sent.body.messages.map((m) => m.role);
  assert.deepEqual(roles, ["user", "assistant", "user"]);
  for (let i = 1; i < roles.length; i++) {
    assert.notEqual(roles[i], roles[i - 1], "roles must alternate");
  }

  // The two opening messages became one, keeping both texts.
  const opening = sent.body.messages[0].content.map((b) => b.text);
  assert.deepEqual(opening, ["first", "actually, this instead"]);

  // tool_result has to come before the text in a merged user message.
  const last = sent.body.messages[2].content;
  assert.equal(last[0].type, "tool_result");
  assert.equal(last[1].type, "text");
});

test("a failed tool result is flagged as an error, not passed off as output", async () => {
  const { sent } = await roundTrip({
    kind: "anthropic",
    messages: [
      { role: "user", content: "go" },
      { role: "assistant", content: "", toolCalls: [{ id: "a", name: "t", input: {} }] },
      { role: "tool", results: [{ id: "a", name: "t", output: "boom", ok: false }] },
    ],
    chunks: anthropicDone,
  });
  const block = sent.body.messages[2].content[0];
  assert.equal(block.type, "tool_result");
  assert.equal(block.is_error, true);
});

/* ---------------------------------------------------------------- reasoning */

test("Anthropic thinking is streamed, and replayed with its signature", async () => {
  const { events } = await roundTrip({
    kind: "anthropic",
    messages: [{ role: "user", content: "go" }],
    chunks: [
      { type: "message_start", message: { usage: { input_tokens: 5 } } },
      { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "let me " } },
      { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "check" } },
      { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig123" } },
      { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "done" } },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } },
    ],
  });
  assert.equal(
    events.filter((e) => e.type === "reasoning").map((e) => e.text).join(""),
    "let me check",
  );
  assert.equal(events.find((e) => e.type === "signature").signature, "sig123");
  assert.equal(events.filter((e) => e.type === "text").map((e) => e.text).join(""), "done");

  // On the way back out it has to be a thinking block, first in the content, with
  // the signature attached - Anthropic rejects a tool continuation without it.
  const { sent } = await roundTrip({
    kind: "anthropic",
    messages: [
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: "done",
        reasoning: "let me check",
        reasoningSignature: "sig123",
        toolCalls: [{ id: "a", name: "t", input: {} }],
      },
      { role: "tool", results: [{ id: "a", name: "t", output: "o", ok: true }] },
    ],
    chunks: anthropicDone,
  });
  const blocks = sent.body.messages[1].content;
  assert.equal(blocks[0].type, "thinking");
  assert.equal(blocks[0].signature, "sig123");
  assert.equal(blocks[1].type, "text");
  assert.equal(blocks[2].type, "tool_use");
});

test("thinking is only requested when a budget is set, and max_tokens makes room", async () => {
  const off = await roundTrip({
    kind: "anthropic",
    messages: [{ role: "user", content: "go" }],
    chunks: anthropicDone,
  });
  assert.equal(off.sent.body.thinking, undefined);
  assert.equal(off.sent.body.max_tokens, 1024);

  const on = await roundTrip({
    kind: "anthropic",
    messages: [{ role: "user", content: "go" }],
    chunks: anthropicDone,
    provider: { thinkingBudget: 4000 },
  });
  assert.deepEqual(on.sent.body.thinking, { type: "enabled", budget_tokens: 4000 });
  assert.ok(on.sent.body.max_tokens > 4000, "the reply needs room on top of the budget");
});

test("both spellings of OpenAI-compatible reasoning are read", async () => {
  // DeepSeek and Zhipu send reasoning_content; OpenRouter sends reasoning.
  for (const field of ["reasoning_content", "reasoning"]) {
    const { events } = await roundTrip({
      kind: "openai",
      messages: [{ role: "user", content: "go" }],
      chunks: [
        { choices: [{ delta: { [field]: "thinking hard" } }] },
        { choices: [{ delta: { content: "answer" } }] },
        { choices: [{ delta: {}, finish_reason: "stop" }] },
      ],
    });
    assert.equal(
      events.find((e) => e.type === "reasoning")?.text,
      "thinking hard",
      `${field} was not read`,
    );
  }
});

test("reasoning_effort is only sent when configured", async () => {
  const bare = await roundTrip({
    kind: "openai",
    messages: [{ role: "user", content: "go" }],
    chunks: openaiDone,
  });
  // Most OpenAI-compatible servers reject an unknown field outright, so this is
  // not a field to send speculatively.
  assert.equal("reasoning_effort" in bare.sent.body, false);

  const asked = await roundTrip({
    kind: "openai",
    messages: [{ role: "user", content: "go" }],
    chunks: openaiDone,
    provider: { reasoningEffort: "high" },
  });
  assert.equal(asked.sent.body.reasoning_effort, "high");
});

/* ------------------------------------------------------------------- routing */

test("each kind posts to its own endpoint with its own auth header", async () => {
  const a = await roundTrip({
    kind: "anthropic",
    messages: [{ role: "user", content: "go" }],
    chunks: anthropicDone,
  });
  assert.equal(a.sent.url, "/v1/v1/messages");
  assert.equal(a.sent.headers["x-api-key"], "test-key");
  assert.equal(a.sent.headers["anthropic-version"], "2023-06-01");

  const o = await roundTrip({
    kind: "openai",
    messages: [{ role: "user", content: "go" }],
    chunks: openaiDone,
  });
  assert.equal(o.sent.url, "/v1/chat/completions");
  assert.equal(o.sent.headers.authorization, "Bearer test-key");
});
