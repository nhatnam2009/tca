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
import { createSession, listSessions } from "./store.js";
import { Runner } from "./loop.js";
import { getStatus } from "./status.js";
import { getCapabilities } from "./capabilities.js";
import { undoLastTurn, redoLastTurn } from "./undo.js";
import {
  adbConnect,
  adbPair,
  adbReconnect,
  applyUnlocks,
  copyRishFiles,
  detectBackend,
  hasBinary,
  installAdb,
  invalidateBackendCache,
  readAdbAddress,
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
    await cmdRun(rest);
    break;
  case "undo":
    await cmdUndo(rest);
    break;
  case "redo":
    await cmdRedo(rest);
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
  tca run [--plan] "task"           one-shot turn in the terminal
  tca undo [session-id]             revert file changes from the last turn
  tca redo [session-id]             reapply reverted file changes
  tca token                         print the URL including the access token
  tca models                        recommended models worth using
  tca doctor                        check this device's setup
  tca power                         what the agent can do here, and what is missing
  tca adb-setup                     unlock Android limits (root / Shizuku / wireless ADB)

Config: ${configPath()}
State:  ${STATE_DIR}`);
}

async function cmdUndo(args) {
  let sessionId = args[0];
  if (!sessionId) {
    const sessions = listSessions();
    if (!sessions.length) {
      console.error(C.red("No sessions found."));
      process.exit(1);
    }
    sessionId = sessions[0].id;
  }
  const { config } = loadConfig();
  const res = await undoLastTurn(sessionId, config.workspace);
  if (res.ok) {
    console.log(C.green(`Undone turn ${res.turn}:`));
    for (const f of res.reverted || []) console.log(`  reverted: ${f}`);
  } else {
    console.error(C.red(res.message || "Undo failed."));
    process.exit(1);
  }
}

async function cmdRedo(args) {
  let sessionId = args[0];
  if (!sessionId) {
    const sessions = listSessions();
    if (!sessions.length) {
      console.error(C.red("No sessions found."));
      process.exit(1);
    }
    sessionId = sessions[0].id;
  }
  const { config } = loadConfig();
  const res = await redoLastTurn(sessionId, config.workspace);
  if (res.ok) {
    console.log(C.green(`Redone turn ${res.turn}:`));
    for (const f of res.reapplied || []) console.log(`  reapplied: ${f}`);
  } else {
    console.error(C.red(res.message || "Redo failed."));
    process.exit(1);
  }
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
  // Before the URL prints, not after. The privileges decide whether a long turn
  // survives at all, and the answer is one keypress; printing a URL first only
  // invites the user to open it and start a task that Android is going to kill.
  await setupPrivileges();
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
 * Two halves, and the split is about whether anyone is watching:
 *
 *   setupPrivileges()   runs before the daemon, may ask a question. Only when
 *                       stdin is a terminal, so Termux:Boot never hangs on it.
 *   managePrivileges()  runs after, asks nothing, and picks up a grant that
 *                       arrives later - from the Shizuku app, or another session.
 */
const PRIVILEGE_RETRY_MS = 20_000;
const PRIVILEGE_RETRY_FOR = 15 * 60_000;

/** One line saying what the unlocks did. Shared so both halves report alike. */
function reportUnlocks(res) {
  const failed = res.applied.filter((a) => !a.ok).length;
  console.log(
    failed
      ? `${C.yellow("[!]")}  Privileges via ${res.kind}: ${res.applied.length - failed}/${res.applied.length} applied.`
      : `${C.green("[ok]")} Privileges via ${res.kind}: process limit lifted.`,
  );
}

/**
 * Get privileged before the daemon starts, asking if that is what it takes.
 *
 * The old version of this only ever printed a suggestion to go and run
 * `tca adb-setup` later, which meant the common case - a phone that has been
 * paired before and just rebooted - needed the user to notice the notice, and
 * then retype an address they had already typed once. Now the address is on
 * disk, so a reboot costs one silent reconnect, and pairing is only asked for
 * when there is genuinely nothing to reconnect to.
 */
async function setupPrivileges() {
  if (!process.env.TERMUX_VERSION) return;

  const { config } = loadConfig();
  const lang = pickLang(config.lang);
  const T = (key, params) => t(lang, key, params);

  // Root and Shizuku survive a reboot on their own, and an adb connection can
  // too if the phone never went down. Nothing to do in any of those cases.
  const backend = await detectBackend();
  if (backend.kind) {
    reportUnlocks(await applyUnlocks(backend.kind));
    return;
  }

  // The reboot case. Android keeps the pairing but drops the connection, so this
  // is usually just `adb connect` against an address we already know.
  const saved = readAdbAddress();
  if (saved) {
    console.log(C.dim(`  ${T("boot.reconnect.trying", { address: saved })}`));
    const again = await adbReconnect();
    if (again.ok) {
      console.log(`${C.green("[ok]")} ${T("boot.reconnect.ok", { address: saved })}`);
      reportUnlocks(await applyUnlocks("adb"));
      return;
    }
    // Stale, not wrong: the port changes when wireless debugging is toggled.
    // Keep it anyway - the next boot may well come up on the same port.
    console.log(`${C.yellow("[!]")}  ${T("boot.reconnect.stale", { address: saved })}`);
  }

  console.log("");
  console.log(`${C.yellow("[!]")}  ${C.bold(T("boot.privNeeded"))}`);
  console.log(`     ${C.dim(T("boot.privWhy"))}`);
  console.log("");

  // No terminal means Termux:Boot, a runit service, or a pipe started this.
  // A prompt there would block a start that nobody is sitting in front of, and
  // the daemon would never come up at all.
  if (!process.stdin.isTTY) {
    console.log(`     ${C.dim(T("boot.noTty"))}`);
    return;
  }

  // One readline interface for the question *and* the wizard it leads into.
  //
  // Two sequential interfaces over process.stdin do work - I checked, by spawning
  // the real thing and feeding it lines - so this is not fixing a hang. It is one
  // fewer thing to be true: the wizard reads five answers after this one, and
  // having a single owner of stdin for the whole exchange means none of that
  // depends on close-then-reopen behaviour holding up on a phone's TTY.
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    let answer = "";
    try {
      answer = (await rl.question(`  ${C.bold(T("boot.setupNow"))} [Y/n] `)).trim().toLowerCase();
    } catch {
      // stdin closed under us; treat it as "no" and get on with starting.
    }
    if (answer === "n" || answer === "no") {
      console.log(`     ${C.dim(T("boot.skipped"))}`);
      return;
    }

    // Into the real wizard rather than a second, worse copy of it inline here: it
    // also offers root and Shizuku, and neither of those needs any pairing.
    await cmdAdbSetup(rl);
    // adb-setup marks a failed attempt on the exit code, which made sense when it
    // was the whole process. The daemon is about to start and keep running, so
    // leaving it set would have `nhatnam` exit non-zero for an unrelated reason.
    process.exitCode = 0;
  } finally {
    rl.close();
  }
}

function managePrivileges() {
  if (!process.env.TERMUX_VERSION) return;

  (async () => {
    // Asks nothing and says nothing unless something changes: setupPrivileges
    // has already reported the current state, and repeating it here would read
    // as a second, contradictory verdict.
    const first = await detectBackend();
    if (first.kind) return;

    const until = Date.now() + PRIVILEGE_RETRY_FOR;
    while (Date.now() < until) {
      await new Promise((r) => setTimeout(r, PRIVILEGE_RETRY_MS));
      invalidateBackendCache();
      let again = await detectBackend();

      // Retry the saved address too, not just root and Shizuku. Turning wireless
      // debugging off and on is the usual way out of a stale port, and it often
      // comes back on the same one - so this heals the reboot case without
      // needing the user to restart the daemon or retype anything.
      if (!again.kind && readAdbAddress()) {
        const back = await adbReconnect();
        if (back.ok) {
          const lang = pickLang(loadConfig().config.lang);
          console.log("");
          console.log(`${C.green("[ok]")} ${t(lang, "boot.reconnect.ok", { address: back.address })}`);
          again = await detectBackend();
        }
      }

      if (!again.kind) continue;
      console.log("");
      console.log(`${C.green("[ok]")} Picked up ${again.kind} privileges - applying the unlocks now.`);
      reportUnlocks(await applyUnlocks(again.kind));
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
 * What the agent can do on this device, grouped by tier, missing items first,
 * with the exact command to fix each one.
 *
 * This used to have a twin in the web UI with an Install button next to every
 * gap. The button was the wrong answer: install.sh installs the whole list in
 * one pass now, so a gap here means something specific went wrong, and the fix
 * text says what - which a button cannot.
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
  // Nothing to tap: the fix line under each gap is the whole answer. Re-running
  // the installer is the blunt way to close several at once.
  console.log(`${C.dim("Re-run the installer to get the whole list back: install.sh")}\n`);
}

/**
 * One turn in the terminal.
 *
 * Shows the same things the web UI shows, because the two drifting apart is how a
 * feature ends up existing but being invisible from the terminal: nested
 * sub-agents, thinking, compaction and what the turn cost.
 * @param {string[]} argv
 */
async function cmdRun(argv) {
  const plan = argv.includes("--plan");
  const text = argv.filter((a) => a !== "--plan").join(" ");
  if (!text.trim()) {
    console.error('usage: tca run [--plan] "what you want done"');
    process.exit(1);
  }
  const { config } = loadConfig();
  if (!config.providers[config.active]) {
    console.error("No provider configured. Run `tca serve` and open Settings, or `tca models` for suggestions.");
    process.exit(1);
  }
  if (plan) config.mode = "plan";

  const { id } = createSession();
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let streaming = false;
  let thinking = false;
  let spend = 0;

  /** Close whatever partial line is on screen before printing a structural line. */
  const breakLine = () => {
    if (streaming || thinking) process.stdout.write("\n");
    streaming = false;
    thinking = false;
  };
  /** Sub-agent output is indented so the nesting is visible without colour. */
  const indent = (ev) => (ev.subagent ? "    " : "  ");

  if (plan) console.log(C.yellow("plan mode: read-only, no file changes\n"));

  const runner = new Runner({
    sessionId: id,
    config,
    emit: (ev) => {
      if (ev.type === "text_delta") {
        if (thinking) breakLine();
        process.stdout.write(ev.text);
        streaming = true;
      } else if (ev.type === "reasoning_delta") {
        // Dimmed, not hidden. When an agent goes wrong the thinking is usually
        // where you can see why, and in a terminal there is nothing to expand.
        if (!thinking) breakLine();
        process.stdout.write(C.dim(ev.text));
        thinking = true;
      } else if (ev.type === "tool_start") {
        breakLine();
        process.stdout.write(`${indent(ev)}${C.cyan(">")} ${ev.name} ${C.dim(summarize(ev.input))}\n`);
      } else if (ev.type === "tool_end") {
        const first = (ev.output || "").split("\n")[0].slice(0, 100);
        const mark = ev.ok ? C.green("<") : C.red("x");
        process.stdout.write(`${indent(ev)}${mark} ${first}\n`);
      } else if (ev.type === "subagent_start") {
        breakLine();
        process.stdout.write(`  ${C.cyan("+")} sub-agent (${ev.kind})\n`);
      } else if (ev.type === "subagent_end") {
        // A sub-agent's last words are streamed text with no trailing newline, so
        // without this its answer and this line end up on the same row.
        breakLine();
        process.stdout.write(`  ${ev.ok ? C.green("+") : C.red("+")} sub-agent done\n`);
      } else if (ev.type === "compacting") {
        breakLine();
        process.stdout.write(C.dim("  summarising the older part of this session to fit the context window\n"));
      } else if (ev.type === "tool_note") {
        breakLine();
        process.stdout.write(`  ${C.yellow("!")} ${ev.text}\n`);
      } else if (ev.type === "usage") {
        if (typeof ev.cost === "number") spend += ev.cost;
      } else if (ev.type === "error") {
        breakLine();
        process.stderr.write(`${C.red("error")}: ${ev.message}\n`);
      } else if (ev.type === "done") {
        breakLine();
      }
    },
  });

  // Terminal approval instead of the web card.
  runner.approve = async ({ command, cwd, reason, kind = "command" }) => {
    const verb = kind === "edit" ? "allow this file change?" : "run this?";
    process.stdout.write(`\n  ${C.yellow(verb)} ${command}\n  ${C.dim(`${reason} (in ${cwd})`)}\n`);
    const answer = (await rl.question("  [y/N] ")).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  };

  await runner.run(text);
  rl.close();
  const cost = spend > 0 ? `  ${C.dim(`$${spend < 0.01 ? spend.toFixed(4) : spend.toFixed(3)}`)}` : "";
  console.log(`\n${C.dim(`session: ${id}`)}${cost}`);
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
 *
 * @param {import("node:readline/promises").Interface} [borrowed]
 *   An interface to read from instead of opening one. The startup flow has already
 *   asked a question on stdin and lends its own, so the whole exchange has a
 *   single owner of the stream. The lender closes it; see done() below.
 */
async function cmdAdbSetup(borrowed) {
  if (!process.env.TERMUX_VERSION) {
    console.error("This command only does anything on Termux/Android.");
    console.error("On a PC, run the adb commands from your desktop shell directly.");
    process.exit(1);
  }

  const { config } = loadConfig();
  const lang = pickLang(config.lang);
  const T = (key, params) => t(lang, key, params);
  const rl = borrowed ?? readline.createInterface({ input: process.stdin, output: process.stdout });
  // Closing a borrowed interface would end the lender's session too, and the
  // lender still has a finally block that expects to do it.
  const done = () => {
    if (!borrowed) rl.close();
  };
  const ask = (q) => rl.question(q);
  const step = (n, total, msg) => console.log(`\n${C.bold(C.cyan(T("power.step", { n, total })))} ${C.bold(msg)}`);
  const ok = (msg) => console.log(`  ${C.green("[ok]")} ${msg}`);
  const warn = (msg) => console.log(`  ${C.yellow("[!]")}  ${msg}`);
  const info = (msg) => console.log(`       ${msg}`);
  const bail = (msg, detail) => {
    console.error(C.red(`  ${msg}`));
    if (detail) info(C.dim(String(detail).slice(0, 300)));
    done();
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
    done();
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
  // adbConnect saved the address once it was proven to work, so the next start
  // reconnects without asking. Say so, because the old advice was the opposite.
  info(C.dim(T("boot.saved", { address: connAddr })));
  warn(T("power.rebootWarn"));
  return finish();
}

