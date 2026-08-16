/**
 * The `tca doctor` view of the world.
 *
 * This used to hold its own hand-written list of checks. It no longer does:
 * capabilities.js is the single source of truth, and this file only reshapes it
 * into the flat `{ id, label, ok, fix }` rows that the terminal prints and the
 * Settings panel renders. One list, two presentations, no drift.
 */

import { getCapabilities } from "./capabilities.js";
import { hasBinary } from "./privilege.js";

export { hasBinary };
export { readPhantomLimit } from "./privilege.js";

/**
 * @typedef {object} StatusCheck
 * @property {string} id          stable key, e.g. "node", "privilege"
 * @property {string} label       short human line, e.g. "Node.js - v22.1.0"
 * @property {boolean|null} ok    true/false, or null for informational-only
 * @property {string} [fix]       what to do about it, shown when ok === false
 */

/**
 * Full status report. Safe to call on any platform: capabilities that only make
 * sense under Termux are omitted rather than reported as failing.
 *
 * Asynchronous on purpose. The privilege probes shell out to `su`, `adb devices`
 * and Shizuku, and `adb devices` with no connection can take seconds; doing that
 * synchronously froze the whole daemon for the length of the request.
 *
 * @param {string} [lang]
 * @returns {Promise<{ termux: boolean, lang: string, score: {have: number, total: number, percent: number}, checks: StatusCheck[] }>}
 */
export async function getStatus(lang = "vi") {
  const caps = await getCapabilities(lang);
  /** @type {StatusCheck[]} */
  const checks = [];

  for (const group of caps.groups) {
    for (const item of group.items) {
      checks.push({
        id: item.id,
        label: item.detail ? `${item.title} - ${item.detail}` : item.title,
        ok: item.ok,
        fix: item.fix,
      });
    }
  }

  // Informational rows: no pass/fail, but worth seeing in `doctor`.
  checks.push({ id: "env_keys", label: caps.envKeys.label, ok: null });
  if (caps.termux) {
    checks.push({ id: "phantom_limit", label: caps.privilege.phantomLabel, ok: null });
  }

  return { termux: caps.termux, lang: caps.lang, score: caps.score, checks };
}
