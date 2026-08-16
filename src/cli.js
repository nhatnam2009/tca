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
  detectBackend,
  hasBinary,
  installAdb,
  invalidateBackendCache,
  rishFilesPresent,
  run as runProcess,
} from "./privilege.js";
import { t, pickLang } from "./i18n.js";

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
  reapplyUnlocks(); // background, never blocks the URL from printing
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
 * Wireless ADB pairing does not survive a reboot, so the phantom process unlock
 * quietly disappears and long turns start dying again with no visible cause. If
 * any privileged backend is reachable, re-apply on every start. Silent when
 * nothing is available: this is opportunistic, not a requirement.
 */
function reapplyUnlocks() {
  if (!process.env.TERMUX_VERSION) return;
  (async () => {
    const backend = await detectBackend();
    if (!backend.kind) return;
    const res = await applyUnlocks(backend.kind);
    const failed = res.applied.filter((a) => !a.ok).length;
    console.log(
      failed
        ? `Privileges (${res.kind}): ${res.applied.length - failed}/${res.applied.length} applied.`
        : `Privileges (${res.kind}): all applied.`,
    );
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

const C = {
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
};

/**
 * Grant the agent the Android privileges it needs.
 *
 * Four ways in, and the cheapest one that works wins. Root and Shizuku need no
 * pairing at all, which the old version of this command could not take advantage
 * of because it hardcoded `adb shell`. The web UI Power tab drives the same
 * functions from privilege.js, so the two cannot diverge.
 */
async function cmdAdbSetup() {
  if (!process.env.TERMUX_VERSION) {
    console.error("This command only does anything on Termux/Android.");
    console.error("On a PC, run the adb commands from your desktop shell directly.");
    process.exit(1);
  }

  const { config } = loadConfig();
  const lang = pickLang(config.lang);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => rl.question(q);
  const step = (n, msg) => console.log(`\n${C.bold(C.cyan(`[${n}]`))} ${C.bold(msg)}`);
  const ok = (msg) => console.log(`  ${C.green("[ok]")} ${msg}`);
  const warn = (msg) => console.log(`  ${C.yellow("[!]")}  ${msg}`);
  const info = (msg) => console.log(`       ${msg}`);

  console.log(C.bold("\n╔══════════════════════════════════════╗"));
  console.log(C.bold("║   TCA - Android privilege setup      ║"));
  console.log(C.bold("╚══════════════════════════════════════╝"));

  const finish = async (label) => {
    invalidateBackendCache();
    const res = await applyUnlocks();
    if (!res.kind) {
      console.error(C.red(`\n${t(lang, "priv.err.no_backend")}`));
      rl.close();
      process.exitCode = 1;
      return;
    }
    console.log(`\n${C.bold(`Applying unlocks via ${res.kind}${label ? ` (${label})` : ""}:`)}`);
    for (const a of res.applied) {
      console.log(`  ${a.ok ? C.green("ok") : C.yellow("!!")}  ${t(lang, a.labelKey)}`);
      if (!a.ok && a.err) info(C.dim(a.err));
    }
    console.log(
      res.ok
        ? C.bold(C.green("\n✓ Done. The agent can now spawn as many processes as it needs."))
        : C.yellow("\nSome unlocks were refused. Some vendors block appops even over ADB; the important one is the first."),
    );
    console.log(C.dim("\nCheck any time:  tca power"));
    rl.close();
  };

  // ---- already privileged? then there is nothing to set up ------------------
  step(1, "Checking what is already available");
  const backend = await detectBackend();
  console.log(`  root   ${backend.root.available ? C.green("yes") : C.dim(`no  (${backend.root.note})`)}`);
  console.log(`  shizuku${backend.rish.available ? C.green(" yes") : C.dim(` no  (${backend.rish.note})`)}`);
  console.log(
    `  adb    ${backend.adb.connected ? C.green("connected") : C.dim(`not connected  (${backend.adb.note || "no devices"})`)}`,
  );

  if (backend.kind) {
    ok(`Already usable via ${backend.kind} - no pairing needed.`);
    return finish(null);
  }

  // ---- choose a path -------------------------------------------------------
  step(2, "Choose how to grant privileges");
  console.log("");
  console.log(`  1) ${t(lang, "priv.method.pair.title")}   ${C.dim(t(lang, "priv.method.pair.desc"))}`);
  console.log(`  2) ${t(lang, "priv.method.shizuku.title")}          ${C.dim(t(lang, "priv.method.shizuku.desc"))}`);
  console.log(`  3) ${t(lang, "priv.method.root.title")}       ${C.dim(t(lang, "priv.method.root.desc"))}`);
  console.log("");
  const choice = (await ask("  1 / 2 / 3 ? ")).trim();

  // ---- 3: root ------------------------------------------------------------
  if (choice === "3") {
    step(3, "Trying su");
    invalidateBackendCache();
    const again = await detectBackend();
    if (!again.root.available) {
      console.error(C.red(`  ${t(lang, "priv.err.no_root")}`));
      info(C.dim(again.root.note));
      rl.close();
      process.exitCode = 1;
      return;
    }
    ok("su works.");
    return finish("root");
  }

  // ---- 2: Shizuku ---------------------------------------------------------
  if (choice === "2") {
    step(3, "Shizuku");
    info("1. Install Shizuku from F-Droid or Google Play");
    info("2. Open it and press Start (it does its own wireless pairing, once)");
    info('3. In Shizuku: "Use Shizuku in terminal apps" -> export the files');
    info("4. Copy them into Termux:");
    info(C.bold("     cp ~/storage/shared/Download/rish* ~/"));
    info("     (accept the storage permission first if you have not: termux-setup-storage)");
    console.log("");
    await ask("  Press Enter once the files are in place... ");

    const files = rishFilesPresent();
    if (!files.script || !files.dex) {
      console.error(C.red(`  ${t(lang, "priv.err.rish_missing")}`));
      info(C.dim(`rish: ${files.script ? "found" : "missing"} · rish_shizuku.dex: ${files.dex ? "found" : "missing"}`));
      rl.close();
      process.exitCode = 1;
      return;
    }
    invalidateBackendCache();
    const again = await detectBackend();
    if (!again.rish.available) {
      console.error(C.red(`  ${t(lang, "priv.err.rish_dead")}`));
      info(C.dim(again.rish.note));
      rl.close();
      process.exitCode = 1;
      return;
    }
    ok("Shizuku answered as the shell user.");
    return finish("shizuku");
  }

  // ---- 1: wireless ADB pairing -------------------------------------------
  step(3, "Install adb");
  if (hasBinary("adb")) {
    ok("android-tools already installed");
  } else {
    info("installing android-tools...");
    const r = await installAdb();
    if (!r.ok) {
      console.error(C.red("  Install failed. Try: pkg install android-tools"));
      info(C.dim(r.err.slice(0, 300)));
      rl.close();
      process.exitCode = 1;
      return;
    }
    ok("android-tools installed");
  }

  step(4, "Turn on Wireless debugging");
  info("Settings -> Developer options -> Wireless debugging -> on");
  info('(No Developer options? Settings -> About phone -> tap "Build number" 7 times)');
  console.log("");
  await ask("  Press Enter when Wireless debugging is on... ");

  step(5, "Pair");
  info('Tap "Pair device with pairing code". It shows an IP:PORT and a 6-digit code.');
  info("Note: this port is NOT the same as the one on the main screen.");
  console.log("");
  const pairAddr = (await ask("  Pairing IP:PORT (e.g. 192.168.1.5:38721): ")).trim();
  const pairCode = (await ask("  6-digit code: ")).trim();
  const paired = await adbPair(pairAddr, pairCode);
  if (!paired.ok) {
    console.error(C.red(`  ${t(lang, paired.errKey)}`));
    if (paired.out) info(C.dim(paired.out.slice(0, 300)));
    rl.close();
    process.exitCode = 1;
    return;
  }
  ok("paired");

  step(6, "Connect");
  info("Go back to the main Wireless debugging screen and read the IP:PORT there.");
  console.log("");
  const connAddr = (await ask("  Connect IP:PORT: ")).trim();
  const connected = await adbConnect(connAddr);
  if (!connected.ok) {
    console.error(C.red(`  ${t(lang, connected.errKey)}`));
    if (connected.out) info(C.dim(connected.out.slice(0, 300)));
    rl.close();
    process.exitCode = 1;
    return;
  }
  ok(`connected: ${connAddr}`);
  warn("Wireless ADB pairing is lost on reboot. `tca serve` re-applies the unlocks");
  warn("automatically while the connection lasts; after a reboot, run this again.");
  return finish("wireless adb");
}


