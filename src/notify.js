/**
 * Notifications, on a device where they are the difference between an agent you
 * can use and one you have to babysit.
 *
 * On a phone you switch away from the browser constantly. Without this there is
 * no way to know that a turn finished, or - worse - that it is blocked waiting
 * for you to approve a command, which is a state it can sit in for ten minutes
 * before giving up.
 *
 * Everything here is best-effort and silent on failure. termux-notification only
 * exists if termux-api is installed AND the Termux:API companion app is present;
 * a missing notification must never affect a turn.
 */

import { execFile } from "node:child_process";

const TAG = "tca-agent";

/** Cached: the binary does not appear mid-session. */
let available;

function canNotify() {
  if (available !== undefined) return available;
  available = Boolean(process.env.TERMUX_VERSION);
  return available;
}

/** Only for tests. */
export function resetNotifyProbe() {
  available = undefined;
}

/**
 * @param {string} file
 * @param {string[]} args
 */
function fire(file, args) {
  return new Promise((resolve) => {
    try {
      execFile(file, args, { timeout: 8000 }, () => resolve(undefined));
    } catch {
      resolve(undefined);
    }
  });
}

/**
 * Post (or replace) the agent's notification.
 *
 * A fixed id means each new state replaces the previous one rather than stacking
 * up: one notification that says what is happening now, not a history of every
 * turn you have run today.
 *
 * @param {{title: string, body?: string, priority?: "min"|"low"|"default"|"high", ongoing?: boolean}} o
 */
export async function notify(o) {
  if (!canNotify()) return false;
  const args = ["--id", TAG, "--title", o.title, "--priority", o.priority || "default"];
  if (o.body) args.push("--content", o.body);
  if (o.ongoing) args.push("--ongoing");
  await fire("termux-notification", args);
  return true;
}

export async function clearNotification() {
  if (!canNotify()) return false;
  await fire("termux-notification-remove", [TAG]);
  return true;
}

/**
 * A short vibration, for the one case that actually blocks progress. Deliberately
 * not used for "turn finished": something that buzzes every time is something you
 * turn off.
 */
export async function vibrate(ms = 250) {
  if (!canNotify()) return false;
  await fire("termux-vibrate", ["-d", String(ms), "-f"]);
  return true;
}
