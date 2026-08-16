/**
 * Process spawning, in one place.
 *
 * Split out of tools.js because diagnostics.js needs to run a compiler and
 * tools.js needs to run diagnostics: without this file that is a cycle.
 *
 * /bin/sh is NOT a safe default on Android. Termux keeps its userland under
 * $PREFIX and the system shell is /system/bin/sh, so hardcoding /bin/sh makes
 * every command fail with ENOENT.
 */

import fs from "node:fs";
import { spawn } from "node:child_process";

/** @returns {{ shell: string, flag: string }} */
export function pickShell() {
  if (process.platform === "win32") {
    return { shell: process.env.COMSPEC || "cmd.exe", flag: "/c" };
  }
  const prefix = process.env.PREFIX || "/data/data/com.termux/files/usr";
  const candidates = [
    process.env.SHELL,
    `${prefix}/bin/bash`,
    `${prefix}/bin/sh`,
    "/system/bin/sh", // Android without Termux userland
    "/bin/bash",
    "/bin/sh",
  ];
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return { shell: candidate, flag: "-c" };
  }
  return { shell: "/bin/sh", flag: "-c" };
}

/**
 * Kill a child and everything it spawned.
 *
 * The process group matters on Android specifically: an orphaned grandchild keeps
 * one of the ~32 phantom-process slots occupied until the OS gets round to
 * reaping it, and a coding agent burns through those fast.
 * @param {import("node:child_process").ChildProcess} child
 */
export function killTree(child) {
  if (process.platform === "win32" || !child.pid) {
    child.kill("SIGKILL");
    return;
  }
  try {
    process.kill(-child.pid, "SIGTERM");
    setTimeout(() => {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {}
    }, 3000);
  } catch {
    child.kill("SIGKILL");
  }
}

/**
 * Run a command line through a shell and collect its output.
 *
 * Never rejects on a non-zero exit: the caller decides whether that is a failure.
 * A compiler exiting 1 is the normal, useful case.
 *
 * @param {object} args
 * @param {string} args.command
 * @param {string} args.cwd
 * @param {number} [args.timeout]
 * @param {number} [args.maxOutput]
 * @param {AbortSignal} [args.signal]
 * @param {Record<string,string>} [args.env]
 * @returns {Promise<ExecResult>}
 */
export function run({ command, cwd, timeout, maxOutput, signal, env }) {
  const { shell, flag } = pickShell();
  return spawnCollect(shell, [flag, command], { cwd, timeout, maxOutput, signal, env });
}

/**
 * Run a program with an argv array and no shell at all.
 *
 * This is what anything taking a model-supplied path must use. Quoting a path for
 * a shell is a losing game across platforms - the first version of the diagnostics
 * hook did it and produced `Cannot find module '"fine.mjs"'` on Windows, because
 * cmd.exe and Node's own argv escaping each quoted it once. With an argv array
 * there is nothing to quote and no metacharacter can mean anything.
 *
 * @param {object} args
 * @param {string} args.file
 * @param {string[]} args.args
 * @param {string} args.cwd
 * @param {number} [args.timeout]
 * @param {number} [args.maxOutput]
 * @param {AbortSignal} [args.signal]
 * @param {Record<string,string>} [args.env]
 * @returns {Promise<ExecResult>}
 */
export function runArgv({ file, args, cwd, timeout, maxOutput, signal, env }) {
  return spawnCollect(file, args, { cwd, timeout, maxOutput, signal, env });
}

/**
 * @typedef {{code: number|null, signal: string|null, output: string, timedOut: boolean,
 *   truncated: boolean, spawnError?: string}} ExecResult
 */

/**
 * @param {string} file
 * @param {string[]} argv
 * @returns {Promise<ExecResult>}
 */
function spawnCollect(file, argv, { cwd, timeout = 120_000, maxOutput = 120_000, signal, env }) {
  return new Promise((resolve) => {
    const child = spawn(file, argv, {
      cwd,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      // TERM=dumb and NO_COLOR keep ANSI escapes out of what the model reads;
      // CI=1 stops interactive prompts from hanging a request with no terminal.
      env: { ...process.env, TERM: "dumb", NO_COLOR: "1", CI: "1", ...(env || {}) },
    });

    let out = "";
    let truncated = false;
    const append = (chunk) => {
      if (out.length > maxOutput) {
        truncated = true;
        return;
      }
      out += chunk;
    };
    child.stdout.on("data", (d) => append(d.toString()));
    child.stderr.on("data", (d) => append(d.toString()));

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeout);
    const onAbort = () => killTree(child);
    signal?.addEventListener("abort", onAbort, { once: true });

    const finish = (result) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };

    child.on("error", (err) =>
      finish({ code: null, signal: null, output: "", timedOut: false, truncated: false, spawnError: err.message }),
    );
    child.on("close", (code, sig) => finish({ code, signal: sig, output: out.trimEnd(), timedOut, truncated }));
  });
}

/** True when `name` is on PATH. Cached: this gets asked once per edit. */
const onPath = new Map();
/** @param {string} name */
export async function hasCommand(name) {
  if (onPath.has(name)) return onPath.get(name);
  const probe = process.platform === "win32" ? `where ${name}` : `command -v ${name}`;
  const { code } = await run({ command: probe, cwd: process.cwd(), timeout: 5_000, maxOutput: 2_000 });
  const found = code === 0;
  onPath.set(name, found);
  return found;
}
