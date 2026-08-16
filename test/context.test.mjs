/**
 * Context management: history repair, compaction, and the session store.
 *
 * The bug this file exists for: the old compactHistory() kept messages[0..2] and
 * the last 6, which left an assistant tool_use whose tool_result had been
 * summarised away and a tool_result whose tool_use was gone. Both providers reject
 * that with a 400, so every session past 30 messages died - and nothing caught it,
 * because the fake provider in agent.test.mjs does not validate pairing.
 *
 * So pairing is asserted directly here, on the shapes that used to break it.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "tca-ctx-"));
process.env.TCA_HOME = path.join(TMP, "state");
process.env.TCA_CONFIG = path.join(TMP, "config.json");

const {
  estimateTokens,
  turnBoundaries,
  pairingErrors,
  repairHistory,
  planCompaction,
  summarize,
  COMPACT_AT,
} = await import("../src/compact.js");
const store = await import("../src/store.js");

/* ------------------------------------------------------------------ fixtures */

/** A realistic agent history: one request, then n rounds of tool use. */
function toolHistory(rounds, { trailing = 0, unanswered = false } = {}) {
  /** @type {any[]} */
  const m = [{ role: "user", content: "make the tests pass" }];
  for (let i = 0; i < rounds; i++) {
    m.push({ role: "assistant", content: "", toolCalls: [{ id: `t${i}`, name: "read_file", input: { path: "a.js" } }] });
    if (!(unanswered && i === rounds - 1)) {
      m.push({ role: "tool", results: [{ id: `t${i}`, name: "read_file", output: "x".repeat(200), ok: true }] });
    }
  }
  for (let j = 0; j < trailing; j++) m.push({ role: "assistant", content: `note ${j}` });
  return m;
}

/** Several complete turns, so there are real boundaries to cut at. */
function multiTurn(turns, roundsPerTurn) {
  /** @type {any[]} */
  const m = [];
  for (let k = 0; k < turns; k++) {
    m.push({ role: "user", content: `task ${k}` });
    for (let i = 0; i < roundsPerTurn; i++) {
      const id = `k${k}_${i}`;
      m.push({ role: "assistant", content: "", toolCalls: [{ id, name: "grep", input: { pattern: "x" } }] });
      m.push({ role: "tool", results: [{ id, name: "grep", output: "y".repeat(3000), ok: true }] });
    }
    m.push({ role: "assistant", content: `done with task ${k}` });
  }
  return m;
}

/* ------------------------------------------------------------------- pairing */

test("pairingErrors names both kinds of orphan, and nothing when valid", () => {
  assert.deepEqual(pairingErrors(toolHistory(3)), []);

  const unanswered = pairingErrors(toolHistory(2, { unanswered: true }));
  assert.equal(unanswered.length, 1);
  assert.match(unanswered[0], /tool_use "t1" has no matching tool_result/);

  const orphan = pairingErrors([
    { role: "user", content: "hi" },
    { role: "tool", results: [{ id: "ghost", name: "read_file", output: "", ok: true }] },
  ]);
  assert.equal(orphan.length, 1);
  assert.match(orphan[0], /tool_result "ghost" has no matching tool_use/);
});

test("repairHistory makes a killed-mid-turn session sendable again", () => {
  // The normal case on a phone: Android kills the process between writing the
  // assistant message and writing the tool results.
  const broken = toolHistory(3, { unanswered: true });
  assert.notDeepEqual(pairingErrors(broken), []);

  const fixed = repairHistory(broken);
  assert.deepEqual(pairingErrors(fixed), []);
  // The assistant's own text must survive; dropping the message to fix the
  // pairing would silently lose what it said.
  assert.equal(fixed.filter((m) => m.role === "assistant").length, 3);
  const synthesized = fixed[fixed.length - 1];
  assert.equal(synthesized.role, "tool");
  assert.equal(synthesized.results[0].ok, false);
  assert.match(synthesized.results[0].output, /interrupted/i);
});

test("repairHistory drops a tool_result whose call it has never seen", () => {
  const fixed = repairHistory([
    { role: "user", content: "hi" },
    { role: "tool", results: [{ id: "ghost", name: "x", output: "o", ok: true }] },
    { role: "assistant", content: "hello" },
  ]);
  assert.deepEqual(pairingErrors(fixed), []);
  assert.deepEqual(
    fixed.map((m) => m.role),
    ["user", "assistant"],
  );
});

test("repairHistory leaves a valid history byte-identical", () => {
  const good = toolHistory(4);
  assert.deepEqual(repairHistory(good), good);
});

/* ---------------------------------------------------------------- boundaries */

test("turnBoundaries only ever cuts where no tool call is still open", () => {
  const m = multiTurn(3, 2);
  const at = turnBoundaries(m);
  assert.ok(at.length >= 2);
  for (const i of at) {
    assert.notEqual(m[i].role, "tool", `boundary ${i} lands on a tool result`);
    assert.deepEqual(pairingErrors(m.slice(0, i)), [], `prefix up to ${i} is not self-contained`);
    assert.deepEqual(pairingErrors(m.slice(i)), [], `suffix from ${i} is not self-contained`);
  }
  assert.ok(!at.includes(0), "cutting at 0 removes nothing");
});

test("a single overlong turn can still be cut", () => {
  // One user message, forty tool rounds. If the only legal cut were a turn start
  // there would be nothing to do here but send an over-budget prompt.
  const m = toolHistory(20);
  const at = turnBoundaries(m);
  assert.ok(at.length > 5, `expected mid-turn cuts, got ${at.length}`);
  for (const i of at) assert.deepEqual(pairingErrors(m.slice(i)), []);
});

test("estimateTokens grows with tool output, not with message count", () => {
  const short = [{ role: "user", content: "hi" }];
  const long = [{ role: "tool", results: [{ id: "a", name: "read_file", output: "z".repeat(40_000), ok: true }] }];
  assert.ok(estimateTokens(long) > estimateTokens(short) * 100);
  // The old trigger was message count, which is why a chat of 31 one-word
  // messages compacted while one 80 KB file dump did not.
  assert.ok(estimateTokens(long) > 8_000);
});

/* ---------------------------------------------------------------- compaction */

test("planCompaction leaves a small history alone", () => {
  const { cut } = planCompaction(toolHistory(3), 200_000);
  assert.equal(cut, 0);
});

test("planCompaction fires on the token limit, not the message count", () => {
  const m = multiTurn(6, 3); // ~54 messages, ~150k chars of tool output
  const window = 18_000;
  const { cut, tokens, limit } = planCompaction(m, window);
  assert.equal(limit, Math.floor(window * COMPACT_AT));
  assert.ok(tokens > limit, `expected ${tokens} > ${limit}`);
  assert.ok(cut > 0, "should have chosen a cut");

  // And the converse: a long conversation of short messages is not compacted,
  // which is the case the old message-count trigger got backwards.
  const chatty = Array.from({ length: 80 }, (_, i) => ({
    role: i % 2 ? "assistant" : "user",
    content: "ok",
  }));
  assert.equal(planCompaction(chatty, window).cut, 0);
});

test("every cut planCompaction can choose leaves a sendable history", () => {
  // The exact shapes that broke the old implementation: an odd number of
  // trailing messages walks the tail boundary across a tool_use/tool_result pair.
  for (let trailing = 0; trailing < 4; trailing++) {
    for (const turns of [3, 4, 5]) {
      const m = [...multiTurn(turns, 3), ...toolHistory(1, { trailing }).slice(1)];
      const { cut } = planCompaction(m, 40_000);
      if (!cut) continue;
      const kept = [{ role: "user", content: "[summary]" }, ...m.slice(cut)];
      if (m[cut].role !== "assistant") kept.splice(1, 0, { role: "assistant", content: "ok" });
      assert.deepEqual(
        pairingErrors(kept),
        [],
        `turns=${turns} trailing=${trailing} cut=${cut} produced an unsendable history`,
      );
    }
  }
});

test("the exact history that used to fail now survives compaction", () => {
  // 31 messages, the shape from the original bug: KEEP_HEAD=2 kept an assistant
  // tool_use whose result had been summarised away, and KEEP_TAIL=6 half the time
  // began the tail on a tool_result whose call was gone.
  const m = toolHistory(15);
  assert.equal(m.length, 31);
  const { cut } = planCompaction(m, 1_600);
  assert.ok(cut > 0, "31 messages of tool output over a 1.6k window must compact");

  const kept = [{ role: "user", content: "[summary]" }, ...m.slice(cut)];
  if (m[cut].role !== "assistant") kept.splice(1, 0, { role: "assistant", content: "ok" });
  assert.deepEqual(pairingErrors(kept), []);
});

test("summarize asks the model, with no tools, and returns its text", async () => {
  /** @type {any[]} */
  const bodies = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      bodies.push(JSON.parse(raw));
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "## Goal\nship it" } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = /** @type {any} */ (server.address()).port;

  try {
    const text = await summarize({
      provider: {
        kind: "openai",
        baseUrl: `http://127.0.0.1:${port}/v1`,
        apiKey: "k",
        model: "fake",
      },
      messages: toolHistory(3),
    });
    assert.equal(text, "## Goal\nship it");
    assert.equal(bodies.length, 1);
    // Offering tools here invites the model to start working again instead of
    // summarising, which is the one thing this call must not do.
    assert.equal(bodies[0].tools, undefined);
    const sent = bodies[0].messages;
    assert.equal(sent[0].role, "system");
    assert.match(sent[0].content, /## Failures/, "the summary spec must reach the model");
    assert.match(sent[1].content, /RESULT read_file ok/, "tool results must be in the transcript");
  } finally {
    server.close();
  }
});

/* --------------------------------------------------------------- the store */

test("the store caches a parse and still sees its own appends", async () => {
  const { id } = store.createSession();
  await store.appendMessage(id, { role: "user", content: "one" });
  const first = store.getSession(id);
  assert.equal(first.messages.length, 1);

  // The cache must not go stale on our own writes; the old code re-read and
  // re-parsed the whole file on every step instead, which is quadratic.
  await store.appendMessage(id, { role: "assistant", content: "two" });
  const second = store.getSession(id);
  assert.equal(second.messages.length, 2);
  assert.equal(second.messages[1].content, "two");

  // An edit from outside this process must still be picked up.
  const file = path.join(process.env.TCA_HOME, "sessions", `${id}.jsonl`);
  fs.appendFileSync(file, `${JSON.stringify({ role: "user", content: "three" })}\n`);
  assert.equal(store.getSession(id).messages.length, 3);
});

test("a checkpoint narrows what the model sees and leaves the transcript whole", async () => {
  const { id } = store.createSession();
  for (const m of toolHistory(4)) await store.appendMessage(id, m);
  const all = store.getSession(id).messages.length;
  assert.equal(all, 9);

  await store.appendCheckpoint(id, "everything so far: read four files", 7);

  // The UI still gets the lot - the user gets to scroll back.
  assert.equal(store.getSession(id).messages.length, all);

  // The model gets the summary plus the tail, and that has to be sendable.
  const view = store.agentHistory(id);
  assert.equal(view.dropped, 7);
  assert.match(view.messages[0].content, /read four files/);
  assert.equal(view.messages[0].role, "user");
  // The tail resumes on an assistant message here, so no acknowledgement is
  // inserted: two assistant messages in a row would break Anthropic's alternation.
  assert.equal(view.head, 1);
  assert.equal(view.messages[1].role, "assistant");
  assert.equal(view.messages.length, view.head + (all - 7));
  assert.deepEqual(pairingErrors(view.messages), []);
});

test("a checkpoint that resumes on a user message gets an acknowledgement", async () => {
  const { id } = store.createSession();
  const m = multiTurn(3, 1);
  for (const x of m) await store.appendMessage(id, x);
  const resumeAt = m.findIndex((x, i) => i > 0 && x.role === "user");
  await store.appendCheckpoint(id, "did the first task", resumeAt);

  const view = store.agentHistory(id);
  assert.equal(view.head, 2);
  assert.equal(view.messages[0].role, "user");
  assert.equal(view.messages[1].role, "assistant");
  assert.equal(view.messages[2].role, "user");
  assert.deepEqual(pairingErrors(view.messages), []);
});

test("a later checkpoint supersedes an earlier one", async () => {
  const { id } = store.createSession();
  for (const m of toolHistory(6)) await store.appendMessage(id, m);
  await store.appendCheckpoint(id, "first summary", 4);
  await store.appendCheckpoint(id, "second summary", 10);
  const view = store.agentHistory(id);
  assert.match(view.summary, /second summary/);
  assert.equal(view.dropped, 10);
});

test("deleting a session clears its cache entry too", async () => {
  const { id } = store.createSession();
  await store.appendMessage(id, { role: "user", content: "hi" });
  store.getSession(id);
  store.deleteSession(id);
  assert.throws(() => store.getSession(id), /no such session/);
});

test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));
