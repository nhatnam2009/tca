/**
 * Local HTTP daemon: JSON API + SSE + the static web UI.
 *
 * Binds 127.0.0.1 only. That is necessary but NOT sufficient on Android: the
 * platform does not isolate localhost between apps, so any installed app can
 * connect to this port. Hence the bearer token on every request, including the
 * static files. Do not "simplify" that away.
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { loadConfig, saveConfig, redactConfig, STATE_DIR, configPath } from "./config.js";
import { listProviders, OTHER } from "./providers.js";
import { catalogInfo, modelsFor, searchModels, downloadFullCatalog, fetchLiveModels } from "./catalog.js";
import { RECOMMENDED } from "./recommended.js";
import { addProvider, testProvider, seedFromEnv } from "./setup.js";
import { createSession, listSessions, getSession, deleteSession } from "./store.js";
import { Runner } from "./loop.js";
import { getStatus } from "./status.js";

const WEB_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "web");
const VERSION = "0.1.0";
const HEARTBEAT_MS = 20_000;
const COOKIE_NAME = "tca_token";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

/** Stable per-install token in private storage. */
export function getToken() {
  const file = path.join(STATE_DIR, "token");
  if (fs.existsSync(file)) {
    const t = fs.readFileSync(file, "utf8").trim();
    if (t) return t;
  }
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const token = crypto.randomBytes(24).toString("base64url");
  fs.writeFileSync(file, `${token}\n`, { mode: 0o600 });
  return token;
}

function tokenMatches(given, expected) {
  if (typeof given !== "string" || given.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}

/**
 * @param {object} [opts]
 * @param {number} [opts.port]
 * @param {string} [opts.host]
 * @param {boolean} [opts.quiet]   suppress the startup banner (tests)
 */
export async function serve(opts = {}) {
  seedFromEnv(); // pick up ANTHROPIC_API_KEY & friends before the first request
  const token = getToken();
  const { config: initial } = loadConfig();
  const port = opts.port ?? initial.port ?? 8787;
  const host = opts.host ?? "127.0.0.1";

  /** @type {Map<string, Set<http.ServerResponse>>} */
  const listeners = new Map();
  /** @type {Map<string, Runner>} */
  const runners = new Map();

  const emitTo = (sessionId, event) => {
    const set = listeners.get(sessionId);
    if (!set) return;
    const frame = `data: ${JSON.stringify(event)}\n\n`;
    for (const res of set) res.write(frame);
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", `http://${host}:${port}`);
    const method = req.method || "GET";
    const isStatic =
      method === "GET" &&
      (url.pathname === "/" || url.pathname === "/index.html" || url.pathname.startsWith("/assets/"));

    // The browser sends no Authorization header when it fetches style.css and
    // app.js, so a token-only rule 401s every subresource and the page renders
    // as raw unstyled HTML with dead buttons. A cookie set on the HTML load
    // fixes that, and is accepted for static GETs ONLY: the API still demands an
    // explicit token, which keeps ambient cookie auth away from anything that
    // mutates state and leaves no CSRF surface.
    const explicit =
      tokenMatches((req.headers.authorization || "").replace(/^Bearer\s+/i, ""), token) ||
      tokenMatches(url.searchParams.get("token") || "", token);
    const authed = explicit || (isStatic && tokenMatches(cookieToken(req), token));

    if (!authed) {
      res.writeHead(401, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }

    try {
      await route(req, res, url, explicit);
    } catch (err) {
      const e = /** @type {Error} */ (err);
      if (!res.headersSent) json(res, 500, { error: `${e.name}: ${e.message}` });
      else res.end();
    }
  });

  async function route(req, res, url, explicit) {
    const { pathname } = url;
    const method = req.method || "GET";

    // ---- static ------------------------------------------------------------
    if (method === "GET" && (pathname === "/" || pathname === "/index.html")) {
      // Only mint the cookie when the caller proved it has the real token.
      const cookie = explicit
        ? `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000`
        : undefined;
      return sendFile(res, path.join(WEB_DIR, "index.html"), cookie);
    }
    if (method === "GET" && pathname.startsWith("/assets/")) {
      const name = path.basename(pathname);
      // Allowlist by extension. Serving anything that happens to sit in src/web
      // is how a leftover style.css.bak ended up publicly readable.
      if (!Object.prototype.hasOwnProperty.call(MIME, path.extname(name))) {
        return json(res, 404, { error: "not found" });
      }
      const file = path.join(WEB_DIR, name);
      if (!fs.existsSync(file)) return json(res, 404, { error: "not found" });
      return sendFile(res, file);
    }

    // ---- state / config ----------------------------------------------------
    if (method === "GET" && pathname === "/api/state") {
      const { config, raw } = loadConfig();
      const provider = config.providers[config.active];
      return json(res, 200, {
        version: VERSION,
        workspace: config.workspace,
        configPath: configPath(),
        configInSharedStorage: configPath().includes(`${path.sep}storage${path.sep}shared${path.sep}`),
        providerReady: Boolean(provider?.apiKey || provider?.baseUrl?.includes("127.0.0.1")),
        active: config.active,
        model: provider?.model || "",
        providerCount: Object.keys(raw.providers).length,
        autoApproveCommands: config.autoApproveCommands,
        catalog: catalogInfo(),
        sessions: listSessions(),
      });
    }
    if (method === "GET" && pathname === "/api/status") {
      return json(res, 200, getStatus());
    }
    if (method === "GET" && pathname === "/api/config") {
      const { raw } = loadConfig();
      return json(res, 200, redactConfig(raw));
    }
    if (method === "PUT" && pathname === "/api/config") {
      const body = await readJson(req);
      const file = saveConfig(body);
      return json(res, 200, { ok: true, path: file });
    }

    // ---- providers & catalog ----------------------------------------------
    if (method === "GET" && pathname === "/api/providers") {
      return json(res, 200, {
        known: listProviders(),
        other: OTHER,
        recommended: RECOMMENDED,
        catalog: catalogInfo(),
      });
    }
    if (method === "GET" && pathname === "/api/catalog") {
      const id = url.searchParams.get("provider") || "";
      return json(res, 200, { provider: id, models: modelsFor(id) });
    }
    if (method === "GET" && pathname === "/api/catalog/search") {
      return json(res, 200, { hits: searchModels(url.searchParams.get("q") || "") });
    }
    if (method === "POST" && pathname === "/api/catalog/download") {
      const info = await downloadFullCatalog();
      return json(res, 200, { ok: true, ...info, catalog: catalogInfo() });
    }
    if (method === "GET" && pathname === "/api/models/live") {
      const { config } = loadConfig();
      const id = url.searchParams.get("provider") || config.active;
      const provider = config.providers[id];
      if (!provider) return json(res, 404, { error: `unknown provider ${id}` });
      try {
        return json(res, 200, { models: await fetchLiveModels(provider) });
      } catch (err) {
        return json(res, 502, { error: /** @type {Error} */ (err).message });
      }
    }
    if (method === "POST" && pathname === "/api/providers") {
      const body = await readJson(req);
      const result = addProvider(body);
      return json(res, 200, { ok: true, ...result });
    }
    if (method === "POST" && pathname === "/api/providers/test") {
      const body = await readJson(req);
      const { config } = loadConfig();
      // Test either an existing configured provider by id, or an inline draft.
      const provider = body.id ? config.providers[body.id] : body.provider;
      if (!provider) return json(res, 400, { error: "provider or id is required" });
      if (body.model) provider.model = body.model;
      return json(res, 200, await testProvider(provider));
    }

    // ---- sessions ----------------------------------------------------------
    if (method === "GET" && pathname === "/api/sessions") {
      return json(res, 200, listSessions());
    }
    if (method === "POST" && pathname === "/api/sessions") {
      return json(res, 200, createSession());
    }

    const sessionMatch = pathname.match(/^\/api\/sessions\/([A-Za-z0-9_-]+)(\/[a-z]+)?$/);
    if (sessionMatch) {
      const id = sessionMatch[1];
      const sub = sessionMatch[2];

      if (method === "GET" && !sub) {
        try {
          return json(res, 200, getSession(id));
        } catch {
          return json(res, 404, { error: "no such session" });
        }
      }
      if (method === "DELETE" && !sub) {
        runners.get(id)?.abort();
        runners.delete(id);
        deleteSession(id);
        return json(res, 200, { ok: true });
      }
      if (method === "GET" && sub === "/events") {
        return openStream(req, res, id);
      }
      if (method === "POST" && sub === "/message") {
        const { text } = await readJson(req);
        if (typeof text !== "string" || !text.trim()) return json(res, 400, { error: "text is required" });
        if (runners.get(id)?.running) return json(res, 409, { error: "a turn is already running" });

        const { config } = loadConfig(); // re-read: settings may have changed
        const runner = new Runner({ sessionId: id, config, emit: (e) => emitTo(id, e) });
        runners.set(id, runner);
        json(res, 202, { ok: true });
        runner.run(text).catch((err) => {
          emitTo(id, { type: "error", message: /** @type {Error} */ (err).message });
        });
        return;
      }
      if (method === "POST" && sub === "/abort") {
        runners.get(id)?.abort();
        return json(res, 200, { ok: true });
      }
    }

    const approvalMatch = pathname.match(/^\/api\/approvals\/([A-Za-z0-9_]+)$/);
    if (method === "POST" && approvalMatch) {
      const { approved } = await readJson(req);
      let handled = false;
      for (const runner of runners.values()) {
        if (runner.resolveApproval(approvalMatch[1], Boolean(approved))) {
          handled = true;
          break;
        }
      }
      return json(res, handled ? 200 : 404, { ok: handled });
    }

    return json(res, 404, { error: `no route for ${method} ${pathname}` });
  }

  function openStream(req, res, sessionId) {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    res.write(": connected\n\n");

    if (!listeners.has(sessionId)) listeners.set(sessionId, new Set());
    listeners.get(sessionId).add(res);

    // Android will drop an idle socket; a comment frame every 20s keeps it and
    // lets the UI distinguish "quiet" from "dead".
    const beat = setInterval(() => res.write(": ping\n\n"), HEARTBEAT_MS);
    const cleanup = () => {
      clearInterval(beat);
      listeners.get(sessionId)?.delete(res);
    };
    req.on("close", cleanup);
    req.on("error", cleanup);
  }

  await new Promise((resolve) => server.listen(port, host, () => resolve(undefined)));

  // port 0 means "any free port", so read back what the OS actually gave us.
  const actualPort = /** @type {import("node:net").AddressInfo} */ (server.address()).port;
  const urlWithToken = `http://${host}:${actualPort}/?token=${token}`;
  if (opts.quiet) return { server, port: actualPort, token, url: urlWithToken };

  console.log(`tca ${VERSION} listening on http://${host}:${actualPort} (loopback only)`);
  console.log(`config:    ${configPath()}`);
  console.log(`workspace: ${initial.workspace}`);
  console.log(`catalog:   ${catalogInfo().source} (${catalogInfo().modelCount} tool-capable models)`);
  console.log("");
  console.log("Open this in the phone browser:");
  console.log(`  ${urlWithToken}`);
  console.log("");
  console.log("Any app on this device can reach 127.0.0.1, so the token is what");
  console.log(`protects the agent. It lives in ${path.join(STATE_DIR, "token")}.`);

  return { server, port: actualPort, token, url: urlWithToken };
}

// ------------------------------------------------------------------- helpers

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function sendFile(res, file, setCookie) {
  const ext = path.extname(file);
  const body = fs.readFileSync(file);
  res.writeHead(200, {
    "content-type": MIME[ext] || "application/octet-stream",
    "cache-control": "no-store",
    "content-length": body.length,
    ...(setCookie ? { "set-cookie": setCookie } : {}),
    // The UI renders model output; keep it from pulling anything remote.
    "content-security-policy":
      "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; form-action 'none'; base-uri 'none'",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  });
  res.end(body);
}

/** Read our auth cookie out of the request. */
function cookieToken(req) {
  const raw = req.headers.cookie || "";
  for (const part of raw.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== COOKIE_NAME) continue;
    return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return "";
}

function readJson(req, limit = 2_000_000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    /** @type {Buffer[]} */
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("body is not valid JSON"));
      }
    });
    req.on("error", reject);
  });
}
