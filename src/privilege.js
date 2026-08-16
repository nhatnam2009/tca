/**
 * Running privileged commands on Android.
 *
 * A coding agent on Android 12+ needs a handful of one-off `device_config` and
 * `appops` calls, or the OS kills its child processes mid-task. There is more
 * than one way to get permission to make those calls, and the old code assumed
 * exactly one of them (`adb shell`), which meant a rooted phone or a phone with
 * Shizuku already set up still had to go through wireless ADB pairing.
 *
 * So this module is an interface, not a script. Four backends, tried best-first:
 *
 *   root   su -c <cmd>                    survives reboot, nothing to pair
 *   rish   Shizuku's terminal bridge      pairing survives; reopen the app after a reboot
 *   adb    adb shell <cmd>                works, but pairing is lost on every reboot
 *   none   nothing available
 *
 * Everything here is async with a timeout, because `adb devices` on a phone with
 * no connection can sit there for seconds, and the daemon must not block on it.
 *
 * Security note: the only strings that ever reach a process are the fixed
 * commands in UNLOCKS below. The two functions that do take user input (pair and
 * connect) validate it against a strict pattern first and pass it as an argv
 * element, never through a shell.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile, execFileSync } from "node:child_process";

const DEFAULT_TIMEOUT = 12_000;

/**
 * @typedef {"root" | "rish" | "adb"} BackendKind
 * @typedef {object} Backend
 * @property {BackendKind|null} kind
 * @property {string} labelKey            i18n key, e.g. "priv.root.label"
 * @property {string} detailKey
 * @property {string} [note]              raw diagnostic text, not translated
 */

/**
 * Promise wrapper around execFile that never rejects: a failed command is data,
 * not an exception, because "su is not installed" is an expected answer here.
 * @param {string} file
 * @param {string[]} args
 * @param {{timeout?: number, input?: string, env?: Record<string,string>}} [opts]
 * @returns {Promise<{ok: boolean, out: string, err: string}>}
 */
export function run(file, args, opts = {}) {
  return new Promise((resolve) => {
    const child = execFile(
      file,
      args,
      {
        timeout: opts.timeout ?? DEFAULT_TIMEOUT,
        encoding: "utf8",
        env: opts.env ? { ...process.env, ...opts.env } : process.env,
        maxBuffer: 1024 * 1024,
      },
      (error, stdout, stderr) => {
        resolve({
          ok: !error,
          out: String(stdout || "").trim(),
          err: String(stderr || error?.message || "").trim(),
        });
      },
    );
    if (opts.input !== undefined && child.stdin) {
      child.stdin.end(opts.input);
    }
  });
}

/** Is this binary on PATH? Cheap enough to stay synchronous. */
export function hasBinary(name) {
  const which = process.platform === "win32" ? "where" : "which";
  try {
    execFileSync(which, [name], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Async version, used everywhere in this file so nothing blocks the daemon. */
export async function hasBinaryAsync(name) {
  const which = process.platform === "win32" ? "where" : "which";
  const r = await run(which, [name], { timeout: 4000 });
  return r.ok;
}

// --------------------------------------------------------------------- root

/** @returns {Promise<{available: boolean, note: string}>} */
export async function detectRoot() {
  if (!(await hasBinaryAsync("su"))) return { available: false, note: "su not on PATH" };
  const r = await run("su", ["-c", "id -u"], { timeout: 8000 });
  if (!r.ok) return { available: false, note: r.err.slice(0, 200) || "su refused" };
  const uid = r.out.split(/\s+/).pop();
  return { available: uid === "0", note: `uid=${uid}` };
}

// --------------------------------------------------------------------- rish

/**
 * Shizuku ships a `rish` script plus `rish_shizuku.dex` that the user copies
 * into their home directory ("Use Shizuku in terminal apps"). Running it gives a
 * shell as uid 2000, which is exactly the ADB shell user.
 */
export function rishPaths() {
  const home = process.env.HOME || os.homedir();
  return {
    home,
    script: path.join(home, "rish"),
    dex: path.join(home, "rish_shizuku.dex"),
  };
}

export function rishFilesPresent() {
  const { script, dex } = rishPaths();
  return { script: fs.existsSync(script), dex: fs.existsSync(dex) };
}

/** Where Android puts a file the Shizuku app exported. */
function downloadDirs() {
  const home = process.env.HOME || os.homedir();
  return [
    path.join(home, "storage", "shared", "Download"),
    path.join(home, "storage", "shared", "Downloads"),
    path.join(home, "storage", "downloads"),
    "/sdcard/Download",
  ];
}

/**
 * Copy `rish` and `rish_shizuku.dex` out of Download into the home directory.
 *
 * Done with fs, not by shelling out to `cp ~/storage/shared/Download/rish* ~/`.
 * A glob in a shell string is exactly the kind of thing that quietly does the
 * wrong thing when a path contains a space, and there is no reason to spawn a
 * process to copy two files.
 * @returns {{ok: boolean, errKey?: string, from?: string, copied: string[]}}
 */
export function copyRishFiles() {
  const { home, script, dex } = rishPaths();
  const wanted = ["rish", "rish_shizuku.dex"];

  for (const dir of downloadDirs()) {
    if (!fs.existsSync(dir)) continue;
    if (!fs.existsSync(path.join(dir, "rish"))) continue;
    const copied = [];
    for (const name of wanted) {
      const src = path.join(dir, name);
      if (!fs.existsSync(src)) continue;
      fs.copyFileSync(src, path.join(home, name));
      copied.push(name);
    }
    if (copied.includes("rish")) {
      try {
        fs.chmodSync(script, 0o755);
      } catch {
        // Not fatal: rish is invoked through the system shell, not executed.
      }
    }
    resetRishProbe();
    invalidateBackendCache();
    return { ok: copied.length === wanted.length, from: dir, copied, errKey: copied.length ? undefined : "priv.err.rish_missing" };
  }

  // No Download directory at all usually means storage permission was refused.
  const anyDir = downloadDirs().some((d) => fs.existsSync(d));
  return {
    ok: false,
    copied: [],
    errKey: anyDir ? "priv.err.rish_missing" : "priv.shizuku.storageFirst",
  };
}

/** Present, and does it exist next to the dex it needs? */
export function rishReady() {
  const files = rishFilesPresent();
  return files.script && files.dex;
}

/**
 * How to hand a command to rish. Not documented anywhere official, and it has
 * changed between Shizuku versions, so both known shapes are tried once and the
 * winner is remembered. `null` means neither worked.
 * @type {"arg" | "stdin" | null | undefined}
 */
let rishStyle;

/** The system shell: rish needs app_process, which Termux's own sh cannot reach. */
function systemShell() {
  return fs.existsSync("/system/bin/sh") ? "/system/bin/sh" : "sh";
}

async function rishTry(style, cmd) {
  const { script, home } = rishPaths();
  const env = { RISH_APPLICATION_ID: "com.termux", HOME: home };
  if (style === "arg") return run(systemShell(), [script, "-c", cmd], { env });
  return run(systemShell(), [script], { env, input: `${cmd}\n` });
}

/**
 * Run one command through Shizuku. Probes the calling convention on first use.
 * @param {string} cmd
 */
export async function rishRun(cmd) {
  const files = rishFilesPresent();
  if (!files.script || !files.dex) {
    return { ok: false, out: "", err: "rish files missing" };
  }
  if (rishStyle === undefined) {
    for (const style of /** @type {const} */ (["arg", "stdin"])) {
      const probe = await rishTry(style, "id -u");
      if (probe.ok && /(^|\s)2000\s*$/.test(probe.out)) {
        rishStyle = style;
        break;
      }
    }
    if (rishStyle === undefined) rishStyle = null;
  }
  if (rishStyle === null) return { ok: false, out: "", err: "rish did not answer as uid 2000" };
  return rishTry(rishStyle, cmd);
}

/** Forget the probed calling convention, e.g. after the user reopens Shizuku. */
export function resetRishProbe() {
  rishStyle = undefined;
}

/** @returns {Promise<{available: boolean, note: string, files: {script: boolean, dex: boolean}}>} */
export async function detectRish() {
  const files = rishFilesPresent();
  if (!files.script || !files.dex) {
    const missing = [!files.script && "rish", !files.dex && "rish_shizuku.dex"].filter(Boolean);
    return { available: false, note: `missing: ${missing.join(", ")}`, files };
  }
  resetRishProbe();
  const r = await rishRun("id -u");
  const uid = r.out.split(/\s+/).pop();
  return { available: r.ok && uid === "2000", note: r.ok ? `uid=${uid}` : r.err.slice(0, 200), files };
}

// ---------------------------------------------------------------------- adb

/** @returns {Promise<{installed: boolean, connected: boolean, note: string}>} */
export async function detectAdb() {
  if (!(await hasBinaryAsync("adb"))) {
    return { installed: false, connected: false, note: "adb not on PATH" };
  }
  const r = await run("adb", ["devices"], { timeout: 10_000 });
  if (!r.ok) return { installed: true, connected: false, note: r.err.slice(0, 200) };
  const lines = r.out.split("\n").slice(1).map((l) => l.trim()).filter(Boolean);
  const connected = lines.some((l) => /\bdevice$/.test(l));
  return { installed: true, connected, note: lines.join(" | ").slice(0, 200) };
}

// ------------------------------------------------------------- the interface

/**
 * Which backend to use, checked best-first. Cached briefly because the Power
 * panel and the status endpoint both ask, and each probe spawns processes.
 * @type {{at: number, value: any} | null}
 */
let cache = null;
const CACHE_MS = 4000;

export function invalidateBackendCache() {
  cache = null;
  resetRishProbe();
}

/**
 * @returns {Promise<{
 *   kind: BackendKind|null,
 *   labelKey: string,
 *   detailKey: string,
 *   note: string,
 *   root: {available: boolean, note: string},
 *   rish: {available: boolean, note: string, files: {script: boolean, dex: boolean}},
 *   adb: {installed: boolean, connected: boolean, note: string},
 * }>}
 */
export async function detectBackend() {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.value;

  const [root, rish, adb] = await Promise.all([detectRoot(), detectRish(), detectAdb()]);
  /** @type {BackendKind|null} */
  let kind = null;
  if (root.available) kind = "root";
  else if (rish.available) kind = "rish";
  else if (adb.installed && adb.connected) kind = "adb";

  const value = {
    kind,
    labelKey: `priv.${kind ?? "none"}.label`,
    detailKey: `priv.${kind ?? "none"}.detail`,
    note: kind === "root" ? root.note : kind === "rish" ? rish.note : kind === "adb" ? adb.note : "",
    root,
    rish,
    adb,
  };
  cache = { at: Date.now(), value };
  return value;
}

/**
 * Run one privileged command through whichever backend is available.
 * @param {string} cmd  a fixed command from this module, never user input
 * @param {BackendKind} [force]
 */
export async function runPrivileged(cmd, force) {
  const kind = force ?? (await detectBackend()).kind;
  if (!kind) return { ok: false, out: "", err: "no privileged backend", kind: null };
  if (kind === "root") return { ...(await run("su", ["-c", cmd])), kind };
  if (kind === "rish") return { ...(await rishRun(cmd)), kind };
  return { ...(await run("adb", ["shell", cmd])), kind };
}

// -------------------------------------------------------------- the unlocks

/**
 * The reason this module exists. Each entry is idempotent and safe to re-apply,
 * which matters because ADB pairing is lost on reboot and `tca serve` re-runs
 * these on startup.
 */
export const UNLOCKS = [
  {
    id: "phantom",
    labelKey: "priv.unlock.phantom",
    cmds: [
      "/system/bin/device_config set_sync_disabled_for_tests persistent",
      "/system/bin/device_config put activity_manager max_phantom_processes 2147483647",
    ],
  },
  { id: "doze", labelKey: "priv.unlock.doze", cmds: ["dumpsys deviceidle whitelist +com.termux"] },
  { id: "background", labelKey: "priv.unlock.background", cmds: ["cmd appops set com.termux RUN_IN_BACKGROUND allow"] },
  { id: "wakelock", labelKey: "priv.unlock.wakelock", cmds: ["cmd appops set com.termux WAKE_LOCK allow"] },
  { id: "foreground", labelKey: "priv.unlock.foreground", cmds: ["cmd appops set com.termux START_FOREGROUND allow"] },
];

/**
 * Apply every unlock. Reports per-entry so the UI can show which ones a limited
 * ADB shell refused (some vendors block appops).
 * @param {BackendKind} [force]
 */
export async function applyUnlocks(force) {
  const kind = force ?? (await detectBackend()).kind;
  if (!kind) return { kind: null, applied: [], ok: false };

  const applied = [];
  for (const unlock of UNLOCKS) {
    let ok = true;
    let err = "";
    for (const cmd of unlock.cmds) {
      const r = await runPrivileged(cmd, kind);
      if (!r.ok) {
        ok = false;
        err = r.err.slice(0, 200);
      }
    }
    applied.push({ id: unlock.id, labelKey: unlock.labelKey, ok, err });
  }
  invalidateBackendCache();
  return { kind, applied, ok: applied.every((a) => a.ok) };
}

// ------------------------------------------------------------ reading state

/**
 * The child process cap. Readable without any privilege on some builds and not
 * on others, so `null` means "unknown", never "bad".
 * @returns {Promise<number|null>}
 */
export async function readPhantomLimit() {
  const direct = await run("/system/bin/device_config", ["get", "activity_manager", "max_phantom_processes"], {
    timeout: 6000,
  });
  const parse = (s) => {
    const n = Number(String(s).trim());
    return Number.isFinite(n) ? n : null;
  };
  if (direct.ok) {
    const n = parse(direct.out);
    if (n !== null) return n;
  }
  const backend = await detectBackend();
  if (!backend.kind) return null;
  const via = await runPrivileged("/system/bin/device_config get activity_manager max_phantom_processes", backend.kind);
  return via.ok ? parse(via.out) : null;
}

/** Is Termux on the Doze whitelist? `null` when it cannot be read. */
export async function dozeWhitelisted() {
  const backend = await detectBackend();
  if (!backend.kind) return null;
  const r = await runPrivileged("dumpsys deviceidle whitelist", backend.kind);
  if (!r.ok) return null;
  return r.out.includes("com.termux");
}

// -------------------------------------------------------- wireless pairing

export const ADDRESS_RE = /^(?:\d{1,3}\.){3}\d{1,3}:\d{1,5}$/;
export const CODE_RE = /^\d{6}$/;

/** Reject anything that is not literally an IPv4 address and a port. */
export function validAddress(value) {
  const s = String(value || "").trim();
  if (!ADDRESS_RE.test(s)) return null;
  const [ip, port] = s.split(":");
  if (ip.split(".").some((o) => Number(o) > 255)) return null;
  if (Number(port) < 1 || Number(port) > 65535) return null;
  return s;
}

export function validCode(value) {
  const s = String(value || "").trim();
  return CODE_RE.test(s) ? s : null;
}

/** `pkg install android-tools`, non-interactively. */
export async function installAdb() {
  return run(
    "apt-get",
    [
      "install",
      "-y",
      "-o",
      "Dpkg::Options::=--force-confold",
      "-o",
      "Dpkg::Options::=--force-confdef",
      "android-tools",
    ],
    { timeout: 300_000, env: { DEBIAN_FRONTEND: "noninteractive" } },
  );
}

/**
 * `adb pair <addr> <code>`. Both arguments are validated first and passed as
 * argv elements, so no shell metacharacter can matter.
 */
export async function adbPair(address, code) {
  const addr = validAddress(address);
  if (!addr) return { ok: false, errKey: "priv.err.bad_address", out: "" };
  const pin = validCode(code);
  if (!pin) return { ok: false, errKey: "priv.err.bad_code", out: "" };
  if (!(await hasBinaryAsync("adb"))) return { ok: false, errKey: "priv.err.no_adb", out: "" };

  const r = await run("adb", ["pair", addr, pin], { timeout: 30_000 });
  // adb pair exits 0 even for a wrong code on some builds; check the text too.
  const success = r.ok && /successfully paired/i.test(`${r.out}\n${r.err}`);
  if (!success) return { ok: false, errKey: "priv.err.pair_failed", out: `${r.out}\n${r.err}`.trim() };
  return { ok: true, out: r.out };
}

/** `adb connect <addr>`, then confirm with `adb devices`. */
export async function adbConnect(address) {
  const addr = validAddress(address);
  if (!addr) return { ok: false, errKey: "priv.err.bad_address", out: "" };
  if (!(await hasBinaryAsync("adb"))) return { ok: false, errKey: "priv.err.no_adb", out: "" };

  const r = await run("adb", ["connect", addr], { timeout: 30_000 });
  invalidateBackendCache();
  const state = await detectAdb();
  if (!state.connected) {
    return { ok: false, errKey: "priv.err.connect_failed", out: `${r.out}\n${r.err}\n${state.note}`.trim() };
  }
  return { ok: true, out: r.out };
}
