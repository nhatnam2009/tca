/**
 * Android/Termux/ADB environment checks.
 *
 * Shared by `tca doctor` (terminal) and GET /api/status (web UI "Android
 * status" panel in Settings), so the two never drift apart.
 */

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { loadConfig, SHARED_DIR } from "./config.js";
import { pickShell } from "./tools.js";
import { detectFromEnv } from "./providers.js";

/**
 * @typedef {object} StatusCheck
 * @property {string} id          stable key, e.g. "node", "phantom_limit"
 * @property {string} label       short human line, e.g. "Node v20.11.0"
 * @property {boolean|null} ok    true/false, or null for informational-only
 * @property {string} [fix]       what to do about it, shown when ok === false
 */

export function hasBinary(name) {
  try {
    execFileSync(process.platform === "win32" ? "where" : "which", [name], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Phantom process cap (Android 12+). Needs adb/root to read; null if not readable. */
export function readPhantomLimit() {
  try {
    const out = execFileSync("/system/bin/device_config", ["get", "activity_manager", "max_phantom_processes"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const n = Number(out);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null; // not readable without adb, which is expected
  }
}

/** True once `tca adb-setup` has been run and adb still sees the device. */
function adbDeviceConnected() {
  if (!hasBinary("adb")) return null;
  try {
    const out = execFileSync("adb", ["devices"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return out.split("\n").slice(1).some((l) => /\bdevice\s*$/.test(l.trim()));
  } catch {
    return null;
  }
}

/**
 * Full status report. Safe to call on any platform - Termux/Android-only
 * checks are simply omitted (not reported as failing) when not applicable.
 * @returns {{ termux: boolean, checks: StatusCheck[] }}
 */
export function getStatus() {
  const termux = Boolean(process.env.TERMUX_VERSION);
  /** @type {StatusCheck[]} */
  const checks = [];

  const nodeVersion = process.versions.node;
  const major = Number(nodeVersion.split(".")[0]);
  checks.push({
    id: "node",
    label: `Node ${nodeVersion}`,
    ok: major >= 20,
    fix: "Need Node 20+. Run: pkg install nodejs",
  });

  const { config } = loadConfig();
  const providerCount = Object.keys(config.providers).length;
  checks.push({
    id: "providers",
    label: `${providerCount} provider(s) configured`,
    ok: providerCount > 0,
    fix: "Add one in the Settings tab, or export a key like ANTHROPIC_API_KEY and restart.",
  });

  const env = detectFromEnv();
  checks.push({
    id: "env_keys",
    label: env.length ? `Keys in environment: ${env.map((e) => e.envName).join(", ")}` : "No API keys in environment",
    ok: null,
  });

  checks.push({
    id: "workspace",
    label: `Workspace ${config.workspace}`,
    ok: fs.existsSync(config.workspace),
    fix: `Missing. Create it: mkdir -p ${config.workspace}`,
  });

  const { shell } = pickShell();
  checks.push({
    id: "shell",
    label: `Shell ${shell}`,
    ok: fs.existsSync(shell),
    fix: "No usable shell found; run_command will fail. Install bash: pkg install bash",
  });

  checks.push({ id: "git", label: "git", ok: hasBinary("git"), fix: "Recommended: pkg install git" });

  if (termux) {
    const sharedParent = path.dirname(SHARED_DIR);
    checks.push({
      id: "shared_storage",
      label: `Shared storage ${sharedParent}`,
      ok: fs.existsSync(sharedParent),
      fix: "Not granted. Run: termux-setup-storage",
    });

    checks.push({
      id: "wake_lock",
      label: "termux-wake-lock available",
      ok: Boolean(process.env.TERMUX_API_VERSION) || hasBinary("termux-wake-lock"),
      fix: "Install Termux:API (pkg install termux-api), then run termux-wake-lock so Android stops killing the daemon.",
    });

    checks.push({ id: "adb_binary", label: "adb installed", ok: hasBinary("adb"), fix: "Run: tca adb-setup (installs android-tools for you)" });

    const connected = adbDeviceConnected();
    checks.push({
      id: "adb_connected",
      label:
        connected === null
          ? "adb device: unknown (adb not installed, or check failed)"
          : connected
            ? "adb device: connected"
            : "adb device: not connected",
      ok: connected,
      fix: "Run: tca adb-setup, and pair Wireless Debugging again if the connection expired.",
    });

    const phantom = readPhantomLimit();
    checks.push({
      id: "phantom_limit",
      label: phantom === null ? "Phantom process limit: unknown (needs adb to read)" : `Phantom process limit: ${phantom}`,
      ok: phantom === null ? null : phantom > 1000,
      fix: "Android 12+ kills excess child processes, which breaks long agent runs. Run: tca adb-setup",
    });
  }

  return { termux, checks };
}
