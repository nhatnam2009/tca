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
import { getCapabilities, packagesFor } from "./capabilities.js";
import {
  adbConnect,
  adbPair,
  applyUnlocks,
  copyRishFiles,
  detectBackend,
  hasBinary,
  installAdb,
  installBootScript,
  invalidateBackendCache,
  readPhantomLimit,
  removeBootScript,
  run as runProcess,
} from "./privilege.js";
import { DICT, LANGS, DEFAULT_LANG } from "./i18n.js";

const WEB_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "web");
const VERSION = "0.1.0";
const HEARTBEAT_MS = 20_000;

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
  // dpkg holds a lock: two concurrent taps on "Install" would only produce a
  // confusing failure, so refuse the second one with a 409 instead.
  let installBusy = false;

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

    // The static shell is public, the API is not.
    //
    // It used to all be behind the token, which meant opening the bookmarked
    // http://127.0.0.1:8787/ without ?token= returned raw JSON: {"error":
    // "unauthorized"}. The page that exists precisely to ask for a token could
    // never be reached to ask for it. index.html, app.js and style.css are the
    // public source of this project anyway, so serving them to anyone on
    // loopback gives nothing away, and now the token gate can actually render.
    //
    // This also retires the auth cookie, which only ever existed because the
    // browser sends no Authorization header for <link> and <script>. Every
    // /api/* route below still demands an explicit token, so there is no ambient
    // credential anywhere and therefore no CSRF surface.
    const explicit =
      tokenMatches((req.headers.authorization || "").replace(/^Bearer\s+/i, ""), token) ||
      tokenMatches(url.searchParams.get("token") || "", token);
    const authed = explicit || isStatic;

    if (!authed) {
      res.writeHead(401, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }

    try {
      await route(req, res, url);
    } catch (err) {
      const e = /** @type {Error} */ (err);
      if (!res.headersSent) json(res, 500, { error: `${e.name}: ${e.message}` });
      else res.end();
    }
  });

  async function route(req, res, url) {
    const { pathname } = url;
    const method = req.method || "GET";

    // ---- static ------------------------------------------------------------
    if (method === "GET" && (pathname === "/" || pathname === "/index.html")) {
      return sendFile(res, path.join(WEB_DIR, "index.html"));
    }
    // The translation table, as JSON, for the browser: src/web/app.js is a
    // classic script and cannot import src/i18n.js. Served as a static asset so
    // the token gate itself has language before anyone has authenticated.
    if (method === "GET" && pathname === "/assets/i18n.json") {
      const body = Buffer.from(JSON.stringify({ langs: LANGS, default: DEFAULT_LANG, dict: DICT }));
      res.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        "content-length": body.length,
        "x-content-type-options": "nosniff",
      });
      return res.end(body);
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
      const { config } = loadConfig();
      return json(res, 200, await getStatus(url.searchParams.get("lang") || config.lang));
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

    // ---- capabilities & Android privileges --------------------------------
    // What the agent could do on this device, what is missing, and the three
    // ways to grant it the Android privileges it needs.
    if (method === "GET" && pathname === "/api/capabilities") {
      const { config } = loadConfig();
      return json(res, 200, await getCapabilities(url.searchParams.get("lang") || config.lang));
    }

    if (method === "POST" && pathname === "/api/capabilities/install") {
      const body = await readJson(req);
      return installCapability(res, String(body.id || ""));
    }

    if (method === "GET" && pathname === "/api/privilege") {
      const backend = await detectBackend();
      return json(res, 200, { ...backend, phantomLimit: await readPhantomLimit() });
    }

    if (method === "POST" && pathname === "/api/privilege/recheck") {
      invalidateBackendCache();
      const backend = await detectBackend();
      // Finding a backend is only useful if the unlocks are actually on, and
      // they are lost on reboot, so re-apply as part of every recheck.
      const applied = backend.kind ? await applyUnlocks(backend.kind) : { kind: null, applied: [], ok: false };
      return json(res, 200, { ...backend, applied: applied.applied, appliedOk: applied.ok });
    }

    // Shizuku exports `rish` and `rish_shizuku.dex` into Download; this saves the
    // user typing a cp command with a glob in it.
    if (method === "POST" && pathname === "/api/privilege/copy-rish") {
      const r = copyRishFiles();
      if (!r.ok) return json(res, 400, r);
      const backend = await detectBackend();
      return json(res, 200, { ...r, kind: backend.kind, rish: backend.rish });
    }

    if (method === "POST" && pathname === "/api/privilege/install-adb") {
      if (installBusy) return json(res, 409, { error: "another install is running" });
      installBusy = true;
      try {
        const r = await installAdb();
        invalidateBackendCache();
        return json(res, r.ok ? 200 : 500, {
          ok: r.ok,
          installed: hasBinary("adb"),
          output: `${r.out}\n${r.err}`.trim().slice(0, 4000),
        });
      } finally {
        installBusy = false;
      }
    }

    if (method === "POST" && pathname === "/api/privilege/pair") {
      const body = await readJson(req);
      const r = await adbPair(body.address, body.code);
      return json(res, r.ok ? 200 : 400, r);
    }

    if (method === "POST" && pathname === "/api/privilege/connect") {
      const body = await readJson(req);
      const r = await adbConnect(body.address);
      if (!r.ok) return json(res, 400, r);
      const applied = await applyUnlocks("adb");
      return json(res, 200, { ...r, applied: applied.applied, appliedOk: applied.ok });
    }

    if (method === "POST" && pathname === "/api/privilege/apply") {
      const applied = await applyUnlocks();
      if (!applied.kind) return json(res, 400, { ok: false, errKey: "priv.err.no_backend" });
      return json(res, 200, { ok: applied.ok, kind: applied.kind, applied: applied.applied });
    }

    // Start on boot. We write the script; the app that runs it is a separate APK
    // we can neither install nor see, so the UI says so rather than pretending.
    if (method === "POST" && pathname === "/api/privilege/boot-script") {
      if (!process.env.TERMUX_VERSION) return json(res, 400, { error: "Termux only" });
      const body = await readJson(req);
      if (body.remove) return json(res, 200, removeBootScript());
      const cli = fileURLToPath(new URL("./cli.js", import.meta.url));
      return json(res, 200, installBootScript(cli));
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

  /**
   * Install the packages behind one capability.
   *
   * This is the only place where something a browser sent reaches a process
   * spawn, so it is deliberately narrow:
   *   - the body carries a capability id, never a package name, and the id is
   *     looked up in the fixed table in capabilities.js;
   *   - apt is invoked with an argv array, never through a shell, so no
   *     metacharacter in any input could matter even if one got this far;
   *   - --force-confold plus DEBIAN_FRONTEND=noninteractive, because there is no
   *     terminal here: a dpkg conffile prompt would hang the request forever;
   *   - one install at a time, since dpkg holds a lock anyway and two concurrent
   *     taps would just produce a confusing failure.
   */
  async function installCapability(res, id) {
    if (!process.env.TERMUX_VERSION) {
      return json(res, 400, { error: "package installs are only supported under Termux" });
    }
    const packages = packagesFor(id);
    if (!packages) return json(res, 404, { error: `nothing installable for capability: ${id}` });
    if (installBusy) return json(res, 409, { error: "another install is running" });

    installBusy = true;
    try {
      const r = await runProcess(
        "apt-get",
        ["install", "-y", "-o", "Dpkg::Options::=--force-confold", "-o", "Dpkg::Options::=--force-confdef", ...packages],
        { timeout: 20 * 60_000, env: { DEBIAN_FRONTEND: "noninteractive" } },
      );
      invalidateBackendCache();
      const { config } = loadConfig();
      const caps = await getCapabilities(config.lang);
      const item = caps.groups.flatMap((g) => g.items).find((i) => i.id === id) || null;
      return json(res, r.ok ? 200 : 500, {
        ok: r.ok,
        id,
        packages,
        item,
        output: `${r.out}\n${r.err}`.trim().slice(0, 8000),
      });
    } finally {
      installBusy = false;
    }
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

function sendFile(res, file) {
  const ext = path.extname(file);
  const body = fs.readFileSync(file);
  res.writeHead(200, {
    "content-type": MIME[ext] || "application/octet-stream",
    "cache-control": "no-store",
    "content-length": body.length,
    // The UI renders model output; keep it from pulling anything remote.
    "content-security-policy":
      "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; form-action 'none'; base-uri 'none'",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  });
  res.end(body);
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
