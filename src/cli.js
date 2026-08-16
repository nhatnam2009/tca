#!/usr/bin/env node
/**
 * CLI entry point.
 *
 *   tca serve            start the daemon + web UI (default)
 *   tca run "..."        one-shot turn in the terminal, no browser
 *   tca token            print the URL with the access token
 *   tca models           show the recommended shortlist
 *   tca doctor           check the Termux/Android setup
 *   tca adb-setup        unlock Android limits via wireless ADB (Termux only)
 */

import os from "node:os";
import readline from "node:readline/promises";
import { execFileSync } from "node:child_process";
import { serve, getToken } from "./daemon.js";
import { loadConfig, configPath, STATE_DIR } from "./config.js";
import { RECOMMENDED, TIERS } from "./recommended.js";
import { catalogInfo } from "./catalog.js";
import { seedFromEnv } from "./setup.js";
import { createSession } from "./store.js";
import { Runner } from "./loop.js";
import { getStatus } from "./status.js";
import { getCapabilities } from "./capabilities.js";
import {
  adbConnect,
  adbPair,
  applyUnlocks,
  copyRishFiles,
  detectBackend,
  hasBinary,
  installAdb,
  invalidateBackendCache,
  rishFilesPresent,
  run as runProcess,
} from "./privilege.js";
import { t, pickLang } from "./i18n.js";

/** Terminal colours. Declared here because the command switch below runs during
 *  module evaluation, so anything it reaches has to exist by this point. */
const C = {
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
};
const [command = "serve", ...rest] = process.argv.slice(2);

switch (command) {
  case "serve":
    await cmdServe(rest);
    break;
  case "run":
    await cmdRun(rest.join(" "));
    break;
  case "token":
    cmdToken();
    break;
  case "models":
    cmdModels();
    break;
  case "doctor":
    await cmdDoctor();
    break;
  case "power":
    await cmdPower();
    break;
  case "adb-setup":
    await cmdAdbSetup();
    break;
  case "-h":
  case "--help":
  case "help":
    usage();
    break;
  case "-v":
  case "--version":
    console.log("0.1.0");
    break;
  default:
    console.error(`unknown command: ${command}\n`);
    usage();
    process.exit(1);
}

function usage() {
  console.log(`tca - coding agent with a web UI, built for Termux

  tca serve [--port N] [--host H]   start the daemon and print the UI URL
  tca run "task"                    one-shot turn in the terminal
  tca token                         print the URL including the access token
  tca models                        recommended models worth using
  tca doctor                        check this device's setup
  tca power                         what the agent can do here, and what is missing
  tca adb-setup                     unlock Android limits (root / Shizuku / wireless ADB)

Config: ${configPath()}
State:  ${STATE_DIR}`);
}

async function cmdServe(args) {
  const port = numFlag(args, "--port");
  const hostIdx = args.indexOf("--host");
  const host = hostIdx !== -1 ? args[hostIdx + 1] : undefined;

  if (host && host !== "127.0.0.1" && host !== "localhost") {
    console.error(`REFUSING to bind ${host}.`);
    console.error("This agent can read and write your files and run shell commands.");
    console.error("Exposing it beyond loopback would let anything on the network do that too.");
    console.error("If you truly need remote access, put it behind SSH port forwarding instead:");
    console.error("  ssh -L 8787:127.0.0.1:8787 phone");
    process.exit(1);
  }

  const { added } = seedFromEnv();
  if (added.length) console.log(`Found API keys in the environment for: ${added.join(", ")}\n`);
  await holdWakeLock();
  await serve({ port });
  managePrivileges(); // background, never blocks the URL from printing
}

/**
 * Android suspends the process a few seconds after the screen turns off, which
 * silently stalls a long agent turn. This used to be a manual step in the setup
 * script that everyone forgot; the daemon takes it on itself now, and releases it
 * on the way out so the lock does not outlive the process.
 */
async function holdWakeLock() {
  if (!process.env.TERMUX_VERSION || !hasBinary("termux-wake-lock")) return;
  const r = await runProcess("termux-wake-lock", [], { timeout: 8000 });
  if (!r.ok) return;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    runProcess("termux-wake-release", [], { timeout: 5000 }).catch(() => {});
  };
  process.on("exit", release);
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(sig, () => {
      release();
      process.exit(0);
    });
  }
}

/**
 * Android privileges, handled here rather than in the browser.
 *
 * Every `nhatnam` looks for a privileged backend and applies the unlocks itself.
 * That is the right place for it: the phantom process cap is what silently breaks
 * long turns, and the fix belongs at startup, not behind a tab someone has to
 * find and tap through.
 *
 * When nothing is reachable it keeps checking in the background instead of giving
 * up. Granting ADB means going into Android settings, or opening the Shizuku app,
 * and coming back - so the moment that happens, this notices and applies the
 * unlocks without needing a restart.
 */
const PRIVILEGE_RETRY_MS = 20_000;
const PRIVILEGE_RETRY_FOR = 15 * 60_000;

function managePrivileges() {
  if (!process.env.TERMUX_VERSION) return;

  const report = (res) => {
    const failed = res.applied.filter((a) => !a.ok).length;
    console.log(
      failed
        ? `${C.yellow("[!]")}  Privileges via ${res.kind}: ${res.applied.length - failed}/${res.applied.length} applied.`
        : `${C.green("[ok]")} Privileges via ${res.kind}: process limit lifted.`,
    );
  };

  (async () => {
    const first = await detectBackend();
    if (first.kind) {
      report(await applyUnlocks(first.kind));
      return;
    }

    console.log("");
    console.log(`${C.yellow("[!]")}  ${C.bold("No elevated privileges yet.")}`);
    console.log("     Android caps this app at ~32 child processes and kills the rest,");
    console.log("     so a long task will break part way through.");
    console.log("");
    console.log(`     Set it up now:  ${C.bold("tca adb-setup")}   (root, Shizuku, or wireless ADB)`);
    console.log(`     Or grant it from another Termux session - this will pick it up on its own.`);
    console.log("");

    // Poll rather than ask. The user is going to be in the Android settings app,
    // not looking at this terminal, and a blocking prompt here would stop the
    // daemon from starting at all.
    const until = Date.now() + PRIVILEGE_RETRY_FOR;
    while (Date.now() < until) {
      await new Promise((r) => setTimeout(r, PRIVILEGE_RETRY_MS));
      invalidateBackendCache();
      const again = await detectBackend();
      if (!again.kind) continue;
      console.log("");
      console.log(`${C.green("[ok]")} Picked up ${again.kind} privileges - applying the unlocks now.`);
      report(await applyUnlocks(again.kind));
      return;
    }
  })().catch(() => {});
}

function cmdToken() {
  const { config } = loadConfig();
  const token = getToken();
  console.log(`http://127.0.0.1:${config.port || 8787}/?token=${token}`);
}

function cmdModels() {
  const info = catalogInfo();
  console.log(`Catalog: ${info.source} (${info.modelCount} tool-capable models, ${info.generated})\n`);
  for (const [tier, meta] of Object.entries(TIERS)) {
    console.log(`${meta.label} - ${meta.hint}`);
    for (const r of RECOMMENDED.filter((x) => x.tier === tier)) {
      console.log(`  ${r.provider}/${r.model || "(your local model)"}`);
      console.log(`      ${r.label}: ${r.why}`);
    }
    console.log("");
  }
  console.log("Pick one in the web UI Settings tab, or run: tca serve");
}

async function cmdDoctor() {
  const { config } = loadConfig();
  const { termux, checks, score } = await getStatus(config.lang);

  console.log(`tca doctor - ${os.platform()} ${os.arch()}\n`);
  console.log(termux ? `[- ] Termux ${process.env.TERMUX_VERSION}` : "[- ] Not running under Termux (Android checks skipped)");
  let problems = 0;
  for (const { ok, label, fix } of checks) {
    const mark = ok === null ? "-" : ok ? "ok" : "!!";
    console.log(`[${mark}] ${label}`);
    if (ok === false && fix) {
      problems++;
      for (const line of fix.split("\n")) console.log(`     ${line}`);
    }
  }
  console.log("");
  console.log(`Agent power: ${score.percent}% (${score.have}/${score.total})`);
  console.log(problems ? `${problems} thing(s) to fix. See: tca power` : "Nothing blocking.");
  if (problems) process.exitCode = 1;
}

/**
 * The terminal twin of the web UI's Power panel: grouped by tier, missing items
 * first, with the exact command to fix each one.
 */
async function cmdPower() {
  const { config } = loadConfig();
  const lang = pickLang(config.lang);
  const caps = await getCapabilities(lang);

  const bar = (pct) => {
    const filled = Math.round(pct / 5);
    return `${"#".repeat(filled)}${".".repeat(20 - filled)}`;
  };

  console.log(`\n${t(lang, "status.score")}: ${caps.score.percent}%  [${bar(caps.score.percent)}]\n`);

  if (caps.termux) {
    console.log(`${caps.privilege.label} - ${caps.privilege.detail}`);
    console.log(`${caps.privilege.phantomLabel}\n`);
  }

  for (const group of caps.groups) {
    const missing = group.items.filter((i) => i.ok === false);
    const fine = group.items.filter((i) => i.ok !== false);
    console.log(`${group.title.toUpperCase()} - ${group.hint}`);
    for (const item of missing) {
      console.log(`  [!!] ${item.title}`);
      console.log(`       ${item.why}`);
      console.log(`       -> ${item.fix}`);
      if (item.sizeMb) console.log(`       ${t(lang, "common.size", { n: item.sizeMb })}`);
    }
    if (fine.length) {
      console.log(`  [ok] ${fine.map((i) => i.title).join(", ")}`);
    }
    console.log("");
  }
  console.log("Install any of these with one tap in the web UI: tca serve -> Power tab\n");
}

async function cmdRun(text) {
  if (!text.trim()) {
    console.error('usage: tca run "what you want done"');
    process.exit(1);
  }
  const { config } = loadConfig();
  if (!config.providers[config.active]) {
    console.error("No provider configured. Run `tca serve` and open Settings, or `tca models` for suggestions.");
    process.exit(1);
  }

  const { id } = createSession();
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let streaming = false;

  const runner = new Runner({
    sessionId: id,
    config,
    emit: (ev) => {
      if (ev.type === "text_delta") {
        process.stdout.write(ev.text);
        streaming = true;
      } else if (ev.type === "tool_start") {
        if (streaming) process.stdout.write("\n");
        streaming = false;
        process.stdout.write(`  > ${ev.name} ${summarize(ev.input)}\n`);
      } else if (ev.type === "tool_end") {
        const first = (ev.output || "").split("\n")[0].slice(0, 100);
        process.stdout.write(`  ${ev.ok ? "<" : "x"} ${first}\n`);
      } else if (ev.type === "approval_request") {
        // handled below via the approve override
      } else if (ev.type === "error") {
        process.stderr.write(`\nerror: ${ev.message}\n`);
      } else if (ev.type === "done") {
        process.stdout.write("\n");
      }
    },
  });

  // Terminal approval instead of the web card.
  runner.approve = async ({ command, cwd, reason, kind = "command" }) => {
    const verb = kind === "edit" ? "allow this file change?" : "run this?";
    process.stdout.write(`\n  ${verb} ${command}\n  ${reason} (in ${cwd})\n`);
    const answer = (await rl.question("  [y/N] ")).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  };

  await runner.run(text);
  rl.close();
  console.log(`\nsession: ${id}`);
}

function summarize(input) {
  if (!input || typeof input !== "object") return "";
  const first = input.command || input.path || input.pattern || Object.values(input)[0];
  return String(first ?? "").slice(0, 120);
}

function numFlag(args, name) {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  const n = Number(args[i + 1]);
  return Number.isFinite(n) ? n : undefined;
}

// ------------------------------------------------------------- privilege setup

/**
 * Grant the agent the Android privileges it needs.
 *
 * This lives in the terminal and only in the terminal. It used to be mirrored by a
 * wizard in the web UI, which was the wrong shape for it: granting ADB means
 * leaving the browser for the Android settings app and reading a pairing code off
 * it, so a browser wizard could only ever be a worse copy of this. `tca serve`
 * applies whatever it finds on startup and keeps retrying in the background, so
 * this is the one place that has to be good.
 *
 * Four ways in, cheapest first. Root and Shizuku need no pairing at all.
 */
async function cmdAdbSetup() {
  if (!process.env.TERMUX_VERSION) {
    console.error("This command only does anything on Termux/Android.");
    console.error("On a PC, run the adb commands from your desktop shell directly.");
    process.exit(1);
  }

  const { config } = loadConfig();
  const lang = pickLang(config.lang);
  const T = (key, params) => t(lang, key, params);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => rl.question(q);
  const step = (n, total, msg) => console.log(`\n${C.bold(C.cyan(T("power.step", { n, total })))} ${C.bold(msg)}`);
  const ok = (msg) => console.log(`  ${C.green("[ok]")} ${msg}`);
  const warn = (msg) => console.log(`  ${C.yellow("[!]")}  ${msg}`);
  const info = (msg) => console.log(`       ${msg}`);
  const bail = (msg, detail) => {
    console.error(C.red(`  ${msg}`));
    if (detail) info(C.dim(String(detail).slice(0, 300)));
    rl.close();
    process.exitCode = 1;
  };

  console.log(C.bold(`\n${T("power.privSection")}`));

  /** Apply the unlocks and report each one, then stop. */
  const finish = async () => {
    invalidateBackendCache();
    const res = await applyUnlocks();
    if (!res.kind) return bail(T("priv.err.no_backend"));

    console.log(`\n${C.bold(T(res.kind === "rish" ? "priv.rish.label" : `priv.${res.kind}.label`))}`);
    for (const a of res.applied) {
      console.log(`  ${a.ok ? C.green("ok") : C.yellow("!!")}  ${T(a.labelKey)}`);
      if (!a.ok && a.err) info(C.dim(a.err));
    }
    const okCount = res.applied.filter((a) => a.ok).length;
    console.log(`\n${T("power.applied", { ok: okCount, total: res.applied.length })}`);
    console.log(res.ok ? C.bold(C.green(T("power.appliedAll"))) : C.yellow(T("power.appliedSome")));
    console.log(C.dim("\ntca power"));
    rl.close();
  };

  // ---- already privileged? then there is nothing to set up ------------------
  const backend = await detectBackend();
  console.log("");
  console.log(`  root     ${backend.root.available ? C.green("yes") : C.dim(`no  (${backend.root.note})`)}`);
  console.log(`  shizuku  ${backend.rish.available ? C.green("yes") : C.dim(`no  (${backend.rish.note})`)}`);
  console.log(
    `  adb      ${backend.adb.connected ? C.green("connected") : C.dim(`no  (${backend.adb.note || "no devices"})`)}`,
  );

  if (backend.kind) {
    ok(T(`priv.${backend.kind}.label`));
    return finish();
  }

  // ---- choose a path -------------------------------------------------------
  console.log(`\n${C.bold(T("power.chooseMethod"))}\n`);
  const methods = ["pair", "shizuku", "root", "recheck"];
  for (const [i, m] of methods.entries()) {
    console.log(`  ${i + 1}) ${C.bold(T(`priv.method.${m}.title`))}`);
    console.log(`     ${C.dim(T(`priv.method.${m}.desc`))}`);
  }
  console.log("");
  const choice = (await ask(`  1-${methods.length} ? `)).trim();
  const method = methods[Number(choice) - 1];

  // ---- just look again -----------------------------------------------------
  if (method === "recheck") {
    invalidateBackendCache();
    const again = await detectBackend();
    if (!again.kind) return bail(T("priv.err.no_backend"));
    return finish();
  }

  // ---- root ----------------------------------------------------------------
  if (method === "root") {
    step(1, 1, T("priv.root.check"));
    invalidateBackendCache();
    const again = await detectBackend();
    if (!again.root.available) return bail(T("priv.err.no_root"), again.root.note);
    ok("su");
    return finish();
  }

  // ---- Shizuku -------------------------------------------------------------
  if (method === "shizuku") {
    step(1, 2, T("priv.method.shizuku.title"));
    for (const key of ["priv.shizuku.s1", "priv.shizuku.s2", "priv.shizuku.s3", "priv.shizuku.s4"]) {
      info(T(key));
    }
    console.log("");
    await ask(`  [Enter] ${T("priv.shizuku.copy")} `);

    // Do the copy here rather than making the user type a glob into a shell.
    const copied = copyRishFiles();
    if (copied.ok) ok(T("priv.shizuku.copied"));
    else warn(T(copied.errKey || "priv.err.rish_missing"));

    step(2, 2, T("priv.shizuku.check"));
    const files = rishFilesPresent();
    info(C.dim(`rish: ${files.script ? "✓" : "✗"}   rish_shizuku.dex: ${files.dex ? "✓" : "✗"}`));
    if (!files.script || !files.dex) return bail(T("priv.err.rish_missing"));

    invalidateBackendCache();
    const again = await detectBackend();
    if (!again.rish.available) return bail(T("priv.err.rish_dead"), again.rish.note);
    ok(T("priv.rish.label"));
    return finish();
  }

  // ---- wireless ADB pairing ----------------------------------------------
  step(1, 4, T("priv.pair.installAdb"));
  if (hasBinary("adb")) {
    ok("android-tools");
  } else {
    info(T("common.installing"));
    const r = await installAdb();
    if (!r.ok) return bail(T("priv.err.no_adb"), r.err);
    ok("android-tools");
  }

  step(2, 4, T("priv.pair.s1.title"));
  info(T("priv.pair.s1.body"));
  console.log("");
  await ask(`  [Enter] ${T("priv.pair.s1.done")} `);

  step(3, 4, T("priv.pair.s2.title"));
  info(T("priv.pair.s2.body"));
  console.log("");
  const pairAddr = (await ask(`  ${T("priv.pair.addrLabel")} (192.168.1.5:38721): `)).trim();
  const pairCode = (await ask(`  ${T("priv.pair.codeLabel")}: `)).trim();
  const paired = await adbPair(pairAddr, pairCode);
  if (!paired.ok) return bail(T(paired.errKey), paired.out);
  ok(T("priv.pair.paired"));

  step(4, 4, T("priv.pair.s3.title"));
  info(T("priv.pair.s3.body"));
  console.log("");
  const connAddr = (await ask(`  ${T("priv.pair.connectLabel")}: `)).trim();
  const connected = await adbConnect(connAddr);
  if (!connected.ok) return bail(T(connected.errKey), connected.out);
  ok(`${T("priv.pair.doConnect")}: ${connAddr}`);
  warn(T("power.rebootWarn"));
  return finish();
}

