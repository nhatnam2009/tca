import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import {
  DISCOVERED_PATH,
  DEFAULT_TTL_MS,
  discoverModels,
  discoverOrCache,
  normalizeAnthropicModels,
  normalizeGeminiModels,
  normalizeOpenAIModels,
  loadDiscoveredCache,
  saveDiscoveredCache,
  getCachedModels,
  setCachedModels,
} from "../src/discover.js";

function makeServer(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

test("normalizeAnthropicModels parses data array and extracts ids", () => {
  const input = {
    data: [
      { id: "claude-3-7-sonnet-20250219", display_name: "Claude 3.7 Sonnet" },
      { id: "claude-3-5-haiku-20241022", display_name: "Claude 3.5 Haiku" },
    ],
  };
  const res = normalizeAnthropicModels(input);
  assert.equal(res.length, 2);
  assert.equal(res[0].id, "claude-3-7-sonnet-20250219");
  assert.equal(res[0].name, "Claude 3.7 Sonnet");
  assert.equal(res[1].id, "claude-3-5-haiku-20241022");
});

test("normalizeGeminiModels strips models/ prefix and extracts token limits", () => {
  const input = {
    models: [
      {
        name: "models/gemini-2.5-flash",
        displayName: "Gemini 2.5 Flash",
        inputTokenLimit: 1048576,
      },
      {
        name: "models/gemini-2.5-pro",
        displayName: "Gemini 2.5 Pro",
        inputTokenLimit: 2097152,
      },
    ],
  };
  const res = normalizeGeminiModels(input);
  assert.equal(res.length, 2);
  assert.equal(res[0].id, "gemini-2.5-flash");
  assert.equal(res[0].name, "Gemini 2.5 Flash");
  assert.equal(res[0].context, 1048576);
  assert.equal(res[1].id, "gemini-2.5-pro");
});

test("normalizeOpenAIModels handles standard data array and pricing", () => {
  const input = {
    data: [
      {
        id: "gpt-4o",
        name: "GPT-4o",
        context_window: 128000,
        pricing: { prompt: "0.0000025", completion: "0.00001" },
      },
      {
        id: "deepseek/deepseek-r1",
        name: "DeepSeek R1",
        context_length: 64000,
      },
    ],
  };
  const res = normalizeOpenAIModels(input);
  assert.equal(res.length, 2);
  assert.equal(res[0].id, "gpt-4o");
  assert.equal(res[0].context, 128000);
  assert.deepEqual(res[0].pricing, { input: 2.5, output: 10 });
  assert.equal(res[1].id, "deepseek/deepseek-r1");
  assert.equal(res[1].context, 64000);
});

test("discoverModels queries OpenAI-like endpoint with auth header", async () => {
  let seenAuth = "";
  let seenPath = "";
  const server = await makeServer((req, res) => {
    seenAuth = req.headers.authorization || "";
    seenPath = req.url || "";
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        data: [{ id: "mock-model-1", name: "Mock Model 1" }],
      }),
    );
  });

  try {
    const models = await discoverModels("custom", "test-key-123", server.url);
    assert.equal(seenPath, "/models");
    assert.equal(seenAuth, "Bearer test-key-123");
    assert.equal(models.length, 1);
    assert.equal(models[0].id, "mock-model-1");
  } finally {
    await server.close();
  }
});

test("discoverModels queries Anthropic endpoint with x-api-key", async () => {
  let seenKey = "";
  let seenVersion = "";
  let seenPath = "";
  const server = await makeServer((req, res) => {
    seenKey = req.headers["x-api-key"] || "";
    seenVersion = req.headers["anthropic-version"] || "";
    seenPath = req.url || "";
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        data: [{ id: "claude-3-7-sonnet-20250219", display_name: "Claude 3.7 Sonnet" }],
      }),
    );
  });

  try {
    const models = await discoverModels("anthropic", "sk-ant-test", server.url);
    assert.equal(seenPath, "/v1/models");
    assert.equal(seenKey, "sk-ant-test");
    assert.equal(seenVersion, "2023-06-01");
    assert.equal(models.length, 1);
    assert.equal(models[0].id, "claude-3-7-sonnet-20250219");
  } finally {
    await server.close();
  }
});

test("discoverModels falls back to offline catalog on network error", async () => {
  // Point to a non-existent port
  const models = await discoverModels("anthropic", "key", "http://127.0.0.1:59999");
  assert.ok(Array.isArray(models));
  assert.ok(models.length > 0, "offline catalog should return fallback models for anthropic");
  assert.ok(models.some((m) => m.id.includes("claude")));
});

test("discovered cache persists to disk and respects 24h TTL", () => {
  // Clean state
  const orig = loadDiscoveredCache();
  try {
    const testModels = [{ id: "test-model-abc", name: "Test Model", context: 32000 }];
    setCachedModels("test-provider", testModels);

    const cached = getCachedModels("test-provider");
    assert.deepEqual(cached, testModels);

    // Expired TTL check
    const expired = getCachedModels("test-provider", -1);
    assert.equal(expired, null);
  } finally {
    // Restore cache
    saveDiscoveredCache(orig);
  }
});

test("discoverOrCache uses cache when fresh and bypasses with force", async () => {
  let hits = 0;
  const server = await makeServer((req, res) => {
    hits++;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: [{ id: `model-hit-${hits}` }] }));
  });

  const orig = loadDiscoveredCache();
  try {
    const res1 = await discoverOrCache("cache-test-prov", {
      apiKey: "k",
      baseUrl: server.url,
      force: true,
    });
    assert.equal(res1[0].id, "model-hit-1");
    assert.equal(hits, 1);

    // Second call without force should hit cache
    const res2 = await discoverOrCache("cache-test-prov", {
      apiKey: "k",
      baseUrl: server.url,
      force: false,
    });
    assert.equal(res2[0].id, "model-hit-1");
    assert.equal(hits, 1);

    // Third call with force should hit server
    const res3 = await discoverOrCache("cache-test-prov", {
      apiKey: "k",
      baseUrl: server.url,
      force: true,
    });
    assert.equal(res3[0].id, "model-hit-2");
    assert.equal(hits, 2);
  } finally {
    saveDiscoveredCache(orig);
    await server.close();
  }
});
