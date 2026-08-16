/**
 * What the agent *could* do on this device, and what is missing.
 *
 * The old `tca doctor` answered a different question: "is anything broken?".
 * That is not what a new user needs. They need to know what they are leaving on
 * the table, in terms of what the agent can actually do for them - and then be
 * able to fix it with one tap instead of reading a shell command out of a
 * paragraph of text.
 *
 * So each entry here is a capability, described by benefit rather than by
 * package name ("find code much faster", not "ripgrep"), scored, and grouped
 * into three tiers so the UI can hide everything that is already fine.
 *
 * Every user-visible string is an i18n key. The payload carries both the key and
 * the resolved text: the terminal wants text, the browser wants keys so it can
 * switch language without a round trip.
 */

import fs from "node:fs";
import path from "node:path";
import { loadConfig, SHARED_DIR } from "./config.js";
import { pickShell } from "./tools.js";
import { detectFromEnv } from "./providers.js";
import { bootScriptPath, bootScriptPresent, detectBackend, hasBinaryAsync, readPhantomLimit } from "./privilege.js";
import { t, pickLang } from "./i18n.js";

/**
 * @typedef {"core" | "device" | "optional"} Tier
 *
 * Three groups, and the difference between them is who does the work:
 *
 *   core      install.sh already installed it. Nothing to decide, nothing to tap.
 *             It appears as one health line, and only becomes actionable if the
 *             install actually failed - which is a repair, not a choice.
 *   device    only you can do it: an Android permission dialog, an F-Droid app,
 *             pairing ADB. This is the whole reason the Power tab exists.
 *   optional  heavy, and genuinely a choice. Hundreds of megabytes, so it is
 *             folded away and asks before downloading.
 *
 * The earlier required/recommended/advanced split was wrong: it showed an Install
 * button for ripgrep next to one for a 400 MB toolchain, as though they were the
 * same kind of decision, and kept offering to install things install.sh had
 * already installed.
 *
 * @typedef {object} Capability
 * @property {string} id
 * @property {Tier} tier
 * @property {number} weight        contribution to the score
 * @property {boolean} [termuxOnly] omitted entirely off Termux, never "failing"
 * @property {string[]} [packages]  what to install; empty means not installable
 * @property {number} [sizeMb]      rough download size, shown before installing
 * @property {string} [bin]         detected by this binary being on PATH
 */

/** @type {Capability[]} */
export const CAPABILITIES = [
  // ---- core: install.sh puts these there. A gap here means something broke. ---
  { id: "node", tier: "core", weight: 3, packages: ["nodejs"], sizeMb: 40 },
  { id: "provider", tier: "core", weight: 3 },
  { id: "workspace", tier: "core", weight: 2 },
  { id: "shell", tier: "core", weight: 2, packages: ["bash"], sizeMb: 2 },
  { id: "git", tier: "core", weight: 3, bin: "git", packages: ["git"], sizeMb: 12 },
  { id: "fast_search", tier: "core", weight: 3, bin: "rg", packages: ["ripgrep"], sizeMb: 4 },
  { id: "jq", tier: "core", weight: 1, bin: "jq", packages: ["jq"], sizeMb: 1 },
  { id: "ssh", tier: "core", weight: 1, bin: "sshd", packages: ["openssh"], sizeMb: 10 },
  {
    id: "wake_lock",
    tier: "core",
    weight: 3,
    termuxOnly: true,
    bin: "termux-wake-lock",
    packages: ["termux-api"],
    sizeMb: 1,
  },
  { id: "service", tier: "core", weight: 1, termuxOnly: true, bin: "sv", packages: ["termux-services"], sizeMb: 1 },

  // ---- device: needs you. A dialog, an app from F-Droid, or ADB pairing. ------
  { id: "privilege", tier: "device", weight: 4, termuxOnly: true },
  { id: "storage", tier: "device", weight: 2, termuxOnly: true },
  {
    id: "notifications",
    tier: "device",
    weight: 3,
    termuxOnly: true,
    bin: "termux-notification",
    packages: ["termux-api"],
    sizeMb: 1,
  },
  { id: "boot", tier: "device", weight: 2, termuxOnly: true },

  // ---- optional: heavy, and a real choice. -----------------------------------
  { id: "python", tier: "optional", weight: 2, bin: "python", packages: ["python"], sizeMb: 130 },
  {
    id: "build_tools",
    tier: "optional",
    weight: 2,
    bin: "clang",
    packages: ["clang", "make", "binutils"],
    sizeMb: 400,
  },
  { id: "proot", tier: "optional", weight: 1, bin: "proot-distro", packages: ["proot-distro"], sizeMb: 5 },
];

export const TIERS = /** @type {Tier[]} */ (["core", "device", "optional"]);

/** Capability id -> package names, for the install endpoint's allowlist. */
export function packagesFor(id) {
  const cap = CAPABILITIES.find((c) => c.id === id);
  if (!cap || !cap.packages || !cap.packages.length) return null;
  return cap.packages.slice();
}

/**
 * The checks that need more than "is this binary on PATH".
 * @param {{config: any, termux: boolean, lang: string}} env
 * @returns {Record<string, () => Promise<{ok: boolean|null, params?: Record<string, string|number>, detail?: string}>>}
 */
function specialChecks({ config, termux, lang }) {
  return {
    node: async () => {
      const v = process.versions.node;
      return { ok: Number(v.split(".")[0]) >= 20, detail: `v${v}` };
    },
    provider: async () => {
      const n = Object.keys(config.providers || {}).length;
      return { ok: n > 0, params: { n }, detail: t(lang, "status.providers", { n }) };
    },
    workspace: async () => ({
      ok: fs.existsSync(config.workspace),
      params: { path: config.workspace },
      detail: config.workspace,
    }),
    shell: async () => {
      const { shell } = pickShell();
      return { ok: fs.existsSync(shell), detail: shell };
    },
    storage: async () => {
      if (!termux) return { ok: null };
      const parent = path.dirname(SHARED_DIR);
      return { ok: fs.existsSync(parent), detail: parent };
    },
    wake_lock: async () => ({
      ok: Boolean(process.env.TERMUX_API_VERSION) || (await hasBinaryAsync("termux-wake-lock")),
    }),
    privilege: async () => {
      const backend = await detectBackend();
      return { ok: backend.kind !== null, detail: backend.kind || "" };
    },
    boot: async () => {
      if (!termux) return { ok: null };
      // Only half of this is checkable: the script is ours, the app that runs it
      // is not visible from inside Termux. So "installed" means the script is in
      // place, and the fix text is what tells the user about the app.
      return { ok: bootScriptPresent(), detail: bootScriptPresent() ? bootScriptPath() : "" };
    },
  };
}

/**
 * Evaluate every capability that applies to this device.
 * @param {string} [lang]
 */
export async function getCapabilities(lang = "vi") {
  const L = pickLang(lang);
  const termux = Boolean(process.env.TERMUX_VERSION);
  const { config } = loadConfig();
  const special = specialChecks({ config, termux, lang: L });

  const applicable = CAPABILITIES.filter((c) => !c.termuxOnly || termux);

  const items = await Promise.all(
    applicable.map(async (cap) => {
      let ok = /** @type {boolean|null} */ (null);
      let params = /** @type {Record<string, string|number>} */ ({});
      let detail = "";

      if (special[cap.id]) {
        const r = await special[cap.id]();
        ok = r.ok;
        params = r.params || {};
        detail = r.detail || "";
      } else if (cap.bin) {
        ok = await hasBinaryAsync(cap.bin);
      }

      const titleKey = `cap.${cap.id}.title`;
      const whyKey = `cap.${cap.id}.why`;
      const fixKey = `cap.${cap.id}.fix`;
      return {
        id: cap.id,
        tier: cap.tier,
        weight: cap.weight,
        ok,
        detail,
        params,
        packages: cap.packages || [],
        sizeMb: cap.sizeMb ?? null,
        // Installable means "there is a package and we are on a device that has
        // pkg". `privilege` and `storage` have their own flows instead.
        installable: Boolean(cap.packages && cap.packages.length && termux),
        titleKey,
        whyKey,
        fixKey,
        title: t(L, titleKey, params),
        why: t(L, whyKey, params),
        fix: t(L, fixKey, params),
      };
    }),
  );

  // Score counts only what can be judged: an `ok: null` check is information,
  // not a failure, and must not drag the number down.
  let have = 0;
  let total = 0;
  for (const it of items) {
    if (it.ok === null) continue;
    total += it.weight;
    if (it.ok) have += it.weight;
  }
  const percent = total ? Math.round((have / total) * 100) : 100;

  const groups = TIERS.map((tier) => ({
    tier,
    titleKey: `tier.${tier}`,
    hintKey: `tier.${tier}.hint`,
    title: t(L, `tier.${tier}`),
    hint: t(L, `tier.${tier}.hint`),
    items: items.filter((i) => i.tier === tier),
  })).filter((g) => g.items.length);

  const backend = await detectBackend();
  const phantom = termux ? await readPhantomLimit() : null;

  const env = detectFromEnv();
  return {
    lang: L,
    termux,
    score: { have, total, percent },
    privilege: {
      kind: backend.kind,
      labelKey: backend.labelKey,
      detailKey: backend.detailKey,
      label: t(L, backend.labelKey),
      detail: t(L, backend.detailKey),
      note: backend.note,
      root: { available: backend.root.available, note: backend.root.note },
      rish: { available: backend.rish.available, note: backend.rish.note, files: backend.rish.files },
      adb: backend.adb,
      phantomLimit: phantom,
      phantomLabel:
        phantom === null ? t(L, "status.phantom.unknown") : t(L, "status.phantom.value", { n: phantom }),
    },
    envKeys: {
      names: env.map((e) => e.envName),
      label: env.length
        ? t(L, "status.env_keys", { list: env.map((e) => e.envName).join(", ") })
        : t(L, "status.env_keys.none"),
    },
    groups,
  };
}
