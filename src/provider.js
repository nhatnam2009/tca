/**
 * Wire layer. Two formats, one neutral message shape.
 *
 *   kind "anthropic" -> POST {baseUrl}/v1/messages
 *   kind "openai"    -> POST {baseUrl}/chat/completions
 *
 * Neutral messages (what loop.js and the session store use):
 *   { role: "user",      content: string }
 *   { role: "assistant", content: string, reasoning?: string,
 *                        reasoningSignature?: string, toolCalls?: [{id, name, input}] }
 *   { role: "tool",      results: [{id, name, output, ok}] }
 *
 * stream() is an async generator of:
 *   { type: "text",      text }
 *   { type: "reasoning", text }                 thinking, shown separately in the UI
 *   { type: "signature", signature }            Anthropic thinking attestation
 *   { type: "tool_call", id, name, input }      emitted once arguments are complete
 *   { type: "usage",     input, output, cacheRead, cacheWrite }
 *   { type: "stop",      reason }
 */

/** @typedef {import("./config.js").ProviderConfig} ProviderConfig */

/**
 * @typedef {object} ToolSpec
 * @property {string} name
 * @property {string} description
 * @property {object} parameters   JSON Schema
 */

/**
 * Discriminated union of everything a turn can emit.
 * @typedef {{type: "text", text: string}
 *   | {type: "reasoning", text: string}
 *   | {type: "signature", signature: string}
 *   | {type: "tool_call", id: string, name: string, input: any}
 *   | {type: "usage", input: number, output: number, cacheRead: number, cacheWrite: number}
 *   | {type: "stop", reason: string}} StreamEvent
 */

const RETRY_STATUS = new Set([408, 409, 429, 500, 502, 503, 504, 529]);
const RETRY_CODES = new Set([
  "ECONNRESET",
  "ETIMEDOUT",
  "ECONNREFUSED",
  "EAI_AGAIN",
  "ENETUNREACH",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
]);

export class ProviderError extends Error {
  /** @param {string} message @param {{status?: number, retryable?: boolean}} [opts] */
  constructor(message, opts = {}) {
    super(message);
    this.name = "ProviderError";
    this.status = opts.status;
    this.retryable = Boolean(opts.retryable);
  }
}

/**
 * One assistant turn, streamed. Retries transient failures - mobile networks
 * and Android doze drop connections constantly, so this is not optional.
 *
 * @param {object} args
 * @param {ProviderConfig} args.provider
 * @param {string} args.system
 * @param {any[]} args.messages          neutral shape
 * @param {ToolSpec[]} args.tools
 * @param {AbortSignal} [args.signal]
 * @param {number} [args.maxRetries]
 * @returns {AsyncGenerator<StreamEvent>}
 */
export async function* stream({ provider, system, messages, tools, signal, maxRetries = 3 }) {
  let attempt = 0;
  for (;;) {
    // Track whether this attempt already produced visible content. Retrying
    // after that point would restart the model's reply from scratch while the
    // caller has already displayed/stored the partial text - the retry's full
    // text would then get appended after it, duplicating/garbling the answer.
    let yieldedContent = false;
    try {
      const gen = once({ provider, system, messages, tools, signal });
      for await (const ev of gen) {
        if (ev.type === "text" || ev.type === "tool_call") yieldedContent = true;
        yield ev;
      }
      return;
    } catch (err) {
      const e = /** @type {ProviderError & {cause?: {code?: string}}} */ (err);
      if (signal?.aborted) throw e;
      if (yieldedContent) throw e; // do not silently restart a reply already shown to the user
      const code = e.cause?.code;
      const retryable = e.retryable || (code ? RETRY_CODES.has(code) : false);
      if (!retryable || attempt >= maxRetries) throw e;
      const wait = Math.min(8000, 2 ** attempt * 700) + Math.random() * 300;
      attempt += 1;
      await sleep(wait, signal);
    }
  }
}

/** @returns {AsyncGenerator<StreamEvent>} */
async function* once({ provider, system, messages, tools, signal }) {
  const base = provider.baseUrl.replace(/\/$/, "");
  const anthropic = provider.kind === "anthropic";
  const url = anthropic ? `${base}/v1/messages` : `${base}/chat/completions`;
  const body = anthropic
    ? anthropicBody({ provider, system, messages, tools })
    : openaiBody({ provider, system, messages, tools });

  const res = await fetch(url, {
    method: "POST",
    signal,
    headers: {
      "content-type": "application/json",
      ...(anthropic
        ? { "x-api-key": provider.apiKey, "anthropic-version": "2023-06-01" }
        : provider.apiKey
          ? { authorization: `Bearer ${provider.apiKey}` }
          : {}),
      ...(provider.headers || {}),
    },
    body: JSON.stringify(body),
  });

  if (!res.ok || !res.body) {
    const text = (await res.text().catch(() => "")).slice(0, 500);
    throw new ProviderError(describe(res.status, text), {
      status: res.status,
      retryable: RETRY_STATUS.has(res.status),
    });
  }

  yield* anthropic ? readAnthropic(res) : readOpenai(res);
}

function describe(status, body) {
  const hint =
    status === 401 || status === 403
      ? "API key rejected. Check Settings."
      : status === 402
        ? "Out of credit on the provider account."
        : status === 404
          ? "Endpoint or model not found. Check baseUrl and model id."
          : status === 429
            ? "Rate limited."
            : status >= 500
              ? "Provider is having problems."
              : "";
  return `HTTP ${status}. ${hint} ${body}`.trim();
}

// ---------------------------------------------------------------- request body

/**
 * Where to put prompt-cache breakpoints.
 *
 * Anthropic allows four. One goes on the tool list and one on the system prompt,
 * which together are the largest fixed prefix and change only when the workspace
 * or AGENTS.md changes. The remaining two go on the last two user turns, which is
 * what makes the cache *roll*: the older of the two is still a prefix of the next
 * request, so each turn re-reads the whole conversation from cache instead of
 * paying full price for it.
 *
 * On a phone this is not a micro-optimisation. A 40-step turn re-sends the entire
 * history 40 times; without caching that is quadratic spend on tokens the
 * provider has already seen.
 */
const CACHE = { type: "ephemeral" };

function anthropicBody({ provider, system, messages, tools }) {
  const cache = provider.promptCache !== false;
  /** @type {any[]} */
  const raw = [];
  for (const m of messages) {
    if (m.role === "user") {
      raw.push({ role: "user", content: [{ type: "text", text: m.content }] });
    } else if (m.role === "assistant") {
      /** @type {any[]} */
      const content = [];
      // Thinking blocks must come first, and must be sent back verbatim with
      // their signature: Anthropic rejects a tool-use continuation whose
      // thinking is missing or unsigned once extended thinking is on.
      if (m.reasoning && m.reasoningSignature) {
        content.push({ type: "thinking", thinking: m.reasoning, signature: m.reasoningSignature });
      }
      if (m.content) content.push({ type: "text", text: m.content });
      for (const c of m.toolCalls || []) {
        content.push({ type: "tool_use", id: c.id, name: c.name, input: c.input });
      }
      if (content.length) raw.push({ role: "assistant", content });
    } else if (m.role === "tool") {
      raw.push({
        role: "user",
        content: m.results.map((r) => ({
          type: "tool_result",
          tool_use_id: r.id,
          content: r.output,
          ...(r.ok ? {} : { is_error: true }),
        })),
      });
    }
  }

  const out = coalesceUserTurns(raw);

  if (cache) {
    // Last two user-role entries, which after the mapping above includes tool
    // result batches - they are user-role too, and they are the bulk of a long
    // agent conversation.
    const userIdx = out.map((m, i) => (m.role === "user" ? i : -1)).filter((i) => i >= 0);
    for (const i of userIdx.slice(-2)) {
      const blocks = out[i].content;
      if (blocks?.length) blocks[blocks.length - 1] = { ...blocks[blocks.length - 1], cache_control: CACHE };
    }
  }

  const budget = Number(provider.thinkingBudget) || 0;
  const maxTokens = provider.maxTokens || 8192;

  return {
    model: provider.model,
    // max_tokens has to leave room for the thinking budget on top of the reply,
    // or the request is rejected outright.
    max_tokens: budget ? Math.max(maxTokens, budget + 2048) : maxTokens,
    stream: true,
    ...(system ? { system: cache ? [{ type: "text", text: system, cache_control: CACHE }] : system } : {}),
    ...(budget ? { thinking: { type: "enabled", budget_tokens: budget } } : {}),
    messages: out,
    ...(tools.length
      ? {
          tools: tools.map((t, i) => ({
            name: t.name,
            description: t.description,
            input_schema: t.parameters,
            ...(cache && i === tools.length - 1 ? { cache_control: CACHE } : {}),
          })),
        }
      : {}),
  };
}

/**
 * Merge adjacent user-role messages into one.
 *
 * Anthropic enforces strict role alternation, and the neutral history has three
 * roles that map onto two: both `user` and `tool` become user-side. Two in a row
 * is not exotic - a turn stopped after its tool results were stored leaves a tool
 * message followed by the next user message, and pressing Stop before the model
 * replied leaves two user messages - so this has to be handled rather than
 * asserted away.
 *
 * tool_result blocks are moved to the front of the merged content, which the API
 * requires.
 * @param {any[]} entries
 */
function coalesceUserTurns(entries) {
  /** @type {any[]} */
  const out = [];
  for (const entry of entries) {
    const prev = out[out.length - 1];
    if (prev && prev.role === "user" && entry.role === "user") {
      const merged = [...prev.content, ...entry.content];
      prev.content = [
        ...merged.filter((b) => b.type === "tool_result"),
        ...merged.filter((b) => b.type !== "tool_result"),
      ];
      continue;
    }
    out.push({ ...entry, content: [...entry.content] });
  }
  return out;
}

function openaiBody({ provider, system, messages, tools }) {
  /** @type {any[]} */
  const out = system ? [{ role: "system", content: system }] : [];
  for (const m of messages) {
    if (m.role === "user") {
      out.push({ role: "user", content: m.content });
    } else if (m.role === "assistant") {
      const msg = /** @type {any} */ ({ role: "assistant", content: m.content || "" });
      if (m.toolCalls?.length) {
        msg.tool_calls = m.toolCalls.map((c) => ({
          id: c.id,
          type: "function",
          function: { name: c.name, arguments: JSON.stringify(c.input ?? {}) },
        }));
      }
      out.push(msg);
    } else if (m.role === "tool") {
      for (const r of m.results) {
        out.push({ role: "tool", tool_call_id: r.id, content: r.output });
      }
    }
  }

  // Newer OpenAI models reject max_tokens; most compatible servers only know
  // max_tokens. Pick per host rather than sending both and hoping.
  const isOpenAiHost = /(^|\.)api\.openai\.com$/.test(hostOf(provider.baseUrl));
  const limit = provider.maxTokens || 8192;

  return {
    model: provider.model,
    stream: true,
    stream_options: { include_usage: true },
    ...(isOpenAiHost ? { max_completion_tokens: limit } : { max_tokens: limit }),
    // Only sent when asked for: most compatible servers reject an unknown field,
    // and the ones that support reasoning emit it without being asked anyway.
    ...(provider.reasoningEffort ? { reasoning_effort: provider.reasoningEffort } : {}),
    messages: out,
    ...(tools.length
      ? {
          tools: tools.map((t) => ({
            type: "function",
            function: { name: t.name, description: t.description, parameters: t.parameters },
          })),
          tool_choice: "auto",
        }
      : {}),
  };
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

// -------------------------------------------------------------- SSE decoding

/** Split a byte stream into SSE `data:` payloads. */
async function* sseData(res) {
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).replace(/\r$/, "");
      buf = buf.slice(nl + 1);
      if (!line || line.startsWith(":")) continue; // heartbeat / comment
      if (!line.startsWith("data:")) continue; // event:, id:, retry:
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") return;
      yield payload;
    }
  }
}

/** @returns {AsyncGenerator<StreamEvent>} */
async function* readAnthropic(res) {
  /** @type {Map<number, {id: string, name: string, json: string}>} */
  const blocks = new Map();
  let usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let stopReason = "end_turn";

  for await (const payload of sseData(res)) {
    let ev;
    try {
      ev = JSON.parse(payload);
    } catch {
      continue;
    }
    switch (ev.type) {
      case "message_start": {
        const u = ev.message?.usage || {};
        usage.input = u.input_tokens ?? 0;
        usage.cacheRead = u.cache_read_input_tokens ?? 0;
        usage.cacheWrite = u.cache_creation_input_tokens ?? 0;
        break;
      }
      case "content_block_start":
        if (ev.content_block?.type === "tool_use") {
          blocks.set(ev.index, { id: ev.content_block.id, name: ev.content_block.name, json: "" });
        }
        break;
      case "content_block_delta":
        if (ev.delta?.type === "text_delta") {
          yield { type: "text", text: ev.delta.text };
        } else if (ev.delta?.type === "thinking_delta") {
          yield { type: "reasoning", text: ev.delta.thinking || "" };
        } else if (ev.delta?.type === "signature_delta") {
          yield { type: "signature", signature: ev.delta.signature || "" };
        } else if (ev.delta?.type === "input_json_delta") {
          const b = blocks.get(ev.index);
          if (b) b.json += ev.delta.partial_json || "";
        }
        break;
      case "content_block_stop": {
        const b = blocks.get(ev.index);
        if (b) {
          yield { type: "tool_call", id: b.id, name: b.name, input: parseArgs(b.json) };
          blocks.delete(ev.index);
        }
        break;
      }
      case "message_delta":
        if (ev.delta?.stop_reason) stopReason = ev.delta.stop_reason;
        if (ev.usage?.output_tokens) usage.output = ev.usage.output_tokens;
        break;
      case "error":
        throw new ProviderError(ev.error?.message || "provider stream error", {
          retryable: ev.error?.type === "overloaded_error",
        });
      default:
        break;
    }
  }
  yield { type: "usage", ...usage };
  yield { type: "stop", reason: stopReason };
}

/** @returns {AsyncGenerator<StreamEvent>} */
async function* readOpenai(res) {
  /** @type {Map<number, {id: string, name: string, args: string}>} */
  const calls = new Map();
  let usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let stopReason = "stop";

  for await (const payload of sseData(res)) {
    let ev;
    try {
      ev = JSON.parse(payload);
    } catch {
      continue;
    }
    if (ev.error) {
      throw new ProviderError(ev.error.message || "provider stream error", {
        retryable: ev.error.type === "server_error",
      });
    }
    if (ev.usage) {
      usage = {
        input: ev.usage.prompt_tokens ?? usage.input,
        output: ev.usage.completion_tokens ?? usage.output,
        cacheRead: ev.usage.prompt_tokens_details?.cached_tokens ?? usage.cacheRead,
        cacheWrite: usage.cacheWrite,
      };
    }
    const choice = ev.choices?.[0];
    if (!choice) continue;
    const delta = choice.delta || {};

    // Reasoning models disagree about the field name: DeepSeek and Zhipu send
    // reasoning_content, OpenRouter and a few gateways send reasoning. Neither is
    // part of the OpenAI spec, so accept both rather than pick a side.
    const thought = delta.reasoning_content ?? delta.reasoning;
    if (typeof thought === "string" && thought) yield { type: "reasoning", text: thought };

    if (typeof delta.content === "string" && delta.content) {
      yield { type: "text", text: delta.content };
    } else if (Array.isArray(delta.content)) {
      // A few gateways send content as parts instead of a string.
      for (const part of delta.content) {
        if (part?.type === "text" && part.text) yield { type: "text", text: part.text };
      }
    }

    for (const tc of delta.tool_calls || []) {
      const idx = tc.index ?? 0;
      const cur = calls.get(idx) || { id: tc.id || `call_${idx}`, name: "", args: "" };
      if (tc.id) cur.id = tc.id;
      if (tc.function?.name) cur.name = tc.function.name;
      if (tc.function?.arguments) cur.args += tc.function.arguments;
      calls.set(idx, cur);
    }

    if (choice.finish_reason) {
      stopReason = choice.finish_reason;
      // Arguments only become parseable at finish; flush in call order.
      for (const [idx, c] of [...calls].sort((a, b) => a[0] - b[0])) {
        yield { type: "tool_call", id: c.id, name: c.name, input: parseArgs(c.args) };
        calls.delete(idx);
      }
    }
  }

  // Some servers end the stream without ever sending finish_reason.
  for (const [, c] of [...calls].sort((a, b) => a[0] - b[0])) {
    yield { type: "tool_call", id: c.id, name: c.name, input: parseArgs(c.args) };
  }

  yield { type: "usage", ...usage };
  yield { type: "stop", reason: stopReason };
}

/** Tolerate empty or malformed argument JSON instead of killing the turn. */
function parseArgs(text) {
  const t = (text || "").trim();
  if (!t) return {};
  try {
    return JSON.parse(t);
  } catch {
    return { __raw: t, __parse_error: true };
  }
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve(undefined);
    }, ms);
    function onAbort() {
      clearTimeout(t);
      reject(new Error("aborted"));
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
