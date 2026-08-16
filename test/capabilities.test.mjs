/**
 * Capabilities, privileges, and translations.
 *
 * Three things are worth pinning down here and none of them need a phone:
 *   - the two language tables cannot drift apart, and no code can reference a
 *     key that does not exist in them;
 *   - the capability catalogue is the allowlist for the install endpoint, so an
 *     id that is not in it must never resolve to a package name;
 *   - the two functions that accept user input before spawning a process must
 *     reject anything that is not literally an address or a 6-digit code.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "tca-caps-"));
process.env.TCA_HOME = path.join(TMP, "state");
process.env.TCA_CONFIG = path.join(TMP, "config.json");

const { DICT, LANGS, t, pickLang, DEFAULT_LANG } = await import("../src/i18n.js");
const { CAPABILITIES, TIERS, packagesFor, getCapabilities } = await import("../src/capabilities.js");
const { UNLOCKS, validAddress, validCode, adbPair, adbConnect, detectBackend } = await import(
  "../src/privilege.js"
);
const { getStatus } = await import("../src/status.js");
const { serve } = await import("../src/daemon.js");

const HERE = path.dirname(fileURLToPath(import.meta.url));

/* ------------------------------------------------------------------- i18n */

test("both languages define exactly the same keys", () => {
  assert.deepEqual(LANGS.slice(), ["vi", "en"]);
  const vi = Object.keys(DICT.vi).sort();
  const en = Object.keys(DICT.en).sort();

  const missingInEn = vi.filter((k) => !(k in DICT.en));
  const missingInVi = en.filter((k) => !(k in DICT.vi));
  assert.deepEqual(missingInEn, [], `en is missing: ${missingInEn.join(", ")}`);
  assert.deepEqual(missingInVi, [], `vi is missing: ${missingInVi.join(", ")}`);
  assert.ok(vi.length > 60, `only ${vi.length} keys, the table looks truncated`);
});

test("no translation is left as an empty string", () => {
  for (const lang of LANGS) {
    for (const [key, value] of Object.entries(DICT[lang])) {
      assert.ok(typeof value === "string" && value.trim(), `${lang}.${key} is empty`);
    }
  }
});

test("a placeholder in one language exists in the other too", () => {
  // "{path}" going missing in one language is how a UI ends up showing the word
  // "undefined" to half its users.
  const holes = (s) => (s.match(/\{[a-zA-Z]+\}/g) || []).sort().join(",");
  for (const key of Object.keys(DICT.vi)) {
    assert.equal(holes(DICT.vi[key]), holes(DICT.en[key]), `placeholders differ for ${key}`);
  }
});

test("every key the code asks for is defined", () => {
  const needed = [];
  for (const cap of CAPABILITIES) needed.push(`cap.${cap.id}.title`, `cap.${cap.id}.why`, `cap.${cap.id}.fix`);
  for (const tier of TIERS) needed.push(`tier.${tier}`, `tier.${tier}.hint`);
  for (const u of UNLOCKS) needed.push(u.labelKey);
  for (const kind of ["root", "rish", "adb", "none"]) needed.push(`priv.${kind}.label`, `priv.${kind}.detail`);

  const missing = needed.filter((k) => !(k in DICT.vi) || !(k in DICT.en));
  assert.deepEqual(missing, [], `undefined keys: ${missing.join(", ")}`);
});

test("t() interpolates, falls back to English, then to the key", () => {
  assert.equal(t("vi", "common.size", { n: 12 }), "12 MB");
  assert.equal(t("en", "common.size", { n: 12 }), "12 MB");
  // An unknown key comes back as itself instead of blank, so a bug is visible.
  assert.equal(t("vi", "no.such.key"), "no.such.key");
  // An unknown language falls back rather than throwing.
  assert.equal(t("klingon", "tier.required"), DICT.en["tier.required"]);
});

test("pickLang normalises anything", () => {
  assert.equal(pickLang("vi"), "vi");
  assert.equal(pickLang("vi-VN"), "vi");
  assert.equal(pickLang("en-GB"), "en");
  assert.equal(pickLang("fr"), DEFAULT_LANG);
  assert.equal(pickLang(undefined), DEFAULT_LANG);
  assert.equal(pickLang(""), DEFAULT_LANG);
});

/* ----------------------------------------------------------- capabilities */

test("the catalogue is well formed", () => {
  const ids = new Set();
  for (const cap of CAPABILITIES) {
    assert.ok(cap.id && /^[a-z_]+$/.test(cap.id), `bad id: ${cap.id}`);
    assert.ok(!ids.has(cap.id), `duplicate id: ${cap.id}`);
    ids.add(cap.id);
    assert.ok(TIERS.includes(cap.tier), `${cap.id} has tier ${cap.tier}`);
    assert.ok(Number.isInteger(cap.weight) && cap.weight > 0, `${cap.id} needs a positive weight`);
    if (cap.packages) {
      assert.ok(cap.packages.length > 0, `${cap.id} has an empty packages array`);
      for (const p of cap.packages) {
        // These go on an apt-get command line. Nothing exotic allowed.
        assert.match(p, /^[a-z0-9][a-z0-9+._-]*$/, `${cap.id}: suspicious package name ${p}`);
      }
      assert.ok(typeof cap.sizeMb === "number", `${cap.id} should state a size before downloading`);
    }
  }
  assert.ok(ids.has("privilege"), "the phantom-process capability must exist");
  assert.ok(ids.has("fast_search"), "ripgrep is the biggest speed win; keep it listed");
});

test("packagesFor is an allowlist, not a lookup of whatever was sent", () => {
  assert.deepEqual(packagesFor("fast_search"), ["ripgrep"]);
  assert.deepEqual(packagesFor("build_tools"), ["clang", "make", "binutils"]);

  // Capabilities with their own flow must not be installable.
  assert.equal(packagesFor("privilege"), null);
  assert.equal(packagesFor("provider"), null);

  // And nothing else resolves at all.
  for (const bad of ["", "ripgrep", "nodejs", "../../etc/passwd", "git; rm -rf /", "__proto__", "constructor"]) {
    assert.equal(packagesFor(bad), null, `packagesFor(${JSON.stringify(bad)}) must be null`);
  }
  // A returned array is a copy: a caller cannot mutate the catalogue.
  const first = packagesFor("fast_search");
  first.push("evil");
  assert.deepEqual(packagesFor("fast_search"), ["ripgrep"]);
});

test("getCapabilities scores what it can judge and skips what it cannot", async () => {
  const caps = await getCapabilities("vi");

  assert.equal(caps.lang, "vi");
  assert.ok(caps.groups.length >= 2);
  for (const g of caps.groups) {
    assert.ok(g.items.length, `empty group ${g.tier} should have been dropped`);
    assert.ok(g.title && g.hint);
  }

  const items = caps.groups.flatMap((g) => g.items);
  // Off Termux, the Android-only entries are absent rather than failing.
  if (!caps.termux) {
    for (const id of ["notifications", "wake_lock", "privilege", "storage", "service"]) {
      assert.ok(!items.some((i) => i.id === id), `${id} must be omitted when not on Termux`);
    }
  }

  // The score must only count decided checks.
  const decided = items.filter((i) => i.ok !== null);
  assert.equal(
    caps.score.total,
    decided.reduce((n, i) => n + i.weight, 0),
    "total must be the weight of decided checks only",
  );
  assert.ok(caps.score.percent >= 0 && caps.score.percent <= 100);

  // node is us, so it is knowable and true.
  const node = items.find((i) => i.id === "node");
  assert.equal(node.ok, true);
  assert.match(node.detail, /^v\d+\./);

  // Every item carries both the key and the resolved text: the browser wants
  // keys so it can switch language instantly, the terminal wants text.
  for (const item of items) {
    assert.ok(item.titleKey.startsWith("cap."));
    assert.equal(item.title, t("vi", item.titleKey, item.params));
    assert.notEqual(item.title, item.titleKey, `${item.id} has no Vietnamese title`);
  }
});

test("getCapabilities answers in the requested language", async () => {
  const [vi, en] = await Promise.all([getCapabilities("vi"), getCapabilities("en")]);
  const pick = (c) => c.groups.flatMap((g) => g.items).find((i) => i.id === "fast_search");
  assert.notEqual(pick(vi).title, pick(en).title, "the two languages should differ");
  assert.equal(pick(en).title, DICT.en["cap.fast_search.title"]);
});

test("getStatus is a view of the same data", async () => {
  const status = await getStatus("en");
  const caps = await getCapabilities("en");
  const ids = status.checks.map((c) => c.id);

  for (const item of caps.groups.flatMap((g) => g.items)) {
    assert.ok(ids.includes(item.id), `doctor lost the ${item.id} check`);
  }
  assert.ok(ids.includes("env_keys"), "doctor should still report keys in the environment");
  assert.deepEqual(status.score, caps.score);
});

/* -------------------------------------------------------------- privilege */

test("an address must be an address, and a code must be a code", () => {
  assert.equal(validAddress("192.168.1.5:38721"), "192.168.1.5:38721");
  assert.equal(validAddress("  10.0.0.1:5555  "), "10.0.0.1:5555");

  for (const bad of [
    "",
    "192.168.1.5",
    "192.168.1.5:",
    "192.168.1.999:5555", // octet out of range
    "192.168.1.5:99999", // port out of range
    "192.168.1.5:0",
    "localhost:5555",
    "192.168.1.5:5555; rm -rf /",
    "192.168.1.5:5555 && id",
    "$(whoami):5555",
    "`id`:5555",
    "192.168.1.5:5555\nid",
    "../../etc/passwd",
  ]) {
    assert.equal(validAddress(bad), null, `validAddress(${JSON.stringify(bad)}) must be null`);
  }

  assert.equal(validCode("123456"), "123456");
  for (const bad of ["", "12345", "1234567", "12345a", "123 456", "123456; id", "-123456"]) {
    assert.equal(validCode(bad), null, `validCode(${JSON.stringify(bad)}) must be null`);
  }
});

test("pair and connect refuse bad input before touching a process", async () => {
  // The point is that these return an error key, not that adb is installed:
  // validation happens first, so nothing is ever spawned for junk input.
  const pair = await adbPair("192.168.1.5:5555; rm -rf /", "123456");
  assert.equal(pair.ok, false);
  assert.equal(pair.errKey, "priv.err.bad_address");

  const code = await adbPair("192.168.1.5:5555", "not-a-code");
  assert.equal(code.ok, false);
  assert.equal(code.errKey, "priv.err.bad_code");

  const conn = await adbConnect("`id`");
  assert.equal(conn.ok, false);
  assert.equal(conn.errKey, "priv.err.bad_address");

  // Every error key must be translatable.
  for (const k of [pair.errKey, code.errKey, conn.errKey]) {
    assert.ok(k in DICT.vi, `${k} has no Vietnamese text`);
  }
});

test("the unlock list is fixed, idempotent-looking, and translatable", () => {
  assert.ok(UNLOCKS.length >= 5);
  const ids = UNLOCKS.map((u) => u.id);
  assert.ok(ids.includes("phantom"), "the child-process cap is the whole point");
  assert.equal(new Set(ids).size, ids.length, "duplicate unlock id");
  for (const u of UNLOCKS) {
    assert.ok(u.labelKey in DICT.vi, `${u.id} label is untranslated`);
    for (const cmd of u.cmds) {
      assert.equal(typeof cmd, "string");
      // No interpolation anywhere: these must be literal constants.
      assert.ok(!cmd.includes("${"), `${u.id} interpolates into a command`);
    }
  }
});

test("detectBackend reports every path, and picks none when nothing is available", async () => {
  const b = await detectBackend();
  // On a dev machine there is no su, no rish and no adb device.
  assert.ok(["root", "rish", "adb", null].includes(b.kind));
  assert.equal(b.labelKey, `priv.${b.kind ?? "none"}.label`);
  assert.ok(b.labelKey in DICT.vi);
  // All three probes must be reported, so the UI can explain what is missing.
  assert.equal(typeof b.root.available, "boolean");
  assert.equal(typeof b.rish.available, "boolean");
  assert.equal(typeof b.adb.installed, "boolean");
  assert.equal(typeof b.rish.files.script, "boolean");
});

/* ----------------------------------------------------------------- routes */

test("the capability routes work, and the install route is a narrow door", async (t) => {
  fs.writeFileSync(
    process.env.TCA_CONFIG,
    JSON.stringify({ active: "", providers: {}, workspace: path.join(TMP, "ws") }),
  );
  const { server, port, token } = await serve({ port: 0, quiet: true });
  t.after(() => server.close());
  const call = (p, init = {}) =>
    fetch(`http://127.0.0.1:${port}${p}`, {
      ...init,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(init.headers || {}) },
    });

  const caps = await (await call("/api/capabilities")).json();
  assert.ok(caps.groups.length);
  assert.ok(typeof caps.score.percent === "number");
  assert.ok(caps.privilege, "the Power panel needs the privilege block");

  // Language follows the query string.
  const en = await (await call("/api/capabilities?lang=en")).json();
  assert.equal(en.lang, "en");

  const priv = await (await call("/api/privilege")).json();
  assert.ok("kind" in priv && "root" in priv && "adb" in priv);

  // An unknown capability id must not reach a package manager. Off Termux the
  // route refuses everything, which is itself the first line of defence.
  for (const body of [{ id: "nope" }, { id: "" }, { id: "__proto__" }, {}]) {
    const res = await call("/api/capabilities/install", { method: "POST", body: JSON.stringify(body) });
    assert.ok(res.status === 400 || res.status === 404, `install ${JSON.stringify(body)} -> ${res.status}`);
  }

  // Bad pairing input is rejected with a translatable key, not a 500.
  const bad = await call("/api/privilege/pair", {
    method: "POST",
    body: JSON.stringify({ address: "1.2.3.4:5555; id", code: "123456" }),
  });
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).errKey, "priv.err.bad_address");

  // The i18n table is reachable without a token, and holds both languages.
  const dict = await (await fetch(`http://127.0.0.1:${port}/assets/i18n.json`)).json();
  assert.deepEqual(dict.langs, ["vi", "en"]);
  assert.ok(dict.dict.vi["tier.required"]);
  assert.ok(dict.dict.en["tier.required"]);
});

test("the shipped i18n table is the one the browser gets", () => {
  // A stale hand-written copy under src/web would be the obvious way for the two
  // sides to drift; there must not be one.
  const web = path.join(HERE, "..", "src", "web");
  for (const name of ["i18n.js", "i18n.json", "lang.js", "vi.json", "en.json"]) {
    assert.equal(fs.existsSync(path.join(web, name)), false, `src/web/${name} would duplicate src/i18n.js`);
  }
});

/* ------------------------------------------------------------ rish handling */

test("copyRishFiles finds the export, copies both files, and says why when it cannot", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tca-rish-"));
  const original = process.env.HOME;
  process.env.HOME = home;
  try {
    const { copyRishFiles, rishFilesPresent, rishReady } = await import(
      `../src/privilege.js?rish=${Date.now()}`
    );

    // Nothing anywhere: the message has to distinguish "no Download directory"
    // (storage permission was refused) from "the files are not there".
    const none = copyRishFiles();
    assert.equal(none.ok, false);
    assert.equal(none.errKey, "priv.shizuku.storageFirst");
    assert.equal(rishReady(), false);

    // Shizuku exports into Download.
    const dl = path.join(home, "storage", "shared", "Download");
    fs.mkdirSync(dl, { recursive: true });
    fs.writeFileSync(path.join(dl, "rish"), "#!/system/bin/sh\necho hi\n");
    fs.writeFileSync(path.join(dl, "rish_shizuku.dex"), "dex");

    const copied = copyRishFiles();
    assert.equal(copied.ok, true, JSON.stringify(copied));
    assert.deepEqual(copied.copied.slice().sort(), ["rish", "rish_shizuku.dex"]);
    assert.equal(copied.from, dl);
    assert.deepEqual(rishFilesPresent(), { script: true, dex: true });
    assert.equal(rishReady(), true);
    assert.equal(fs.readFileSync(path.join(home, "rish"), "utf8").includes("echo hi"), true);

    // A half-finished export must not be reported as success.
    fs.rmSync(path.join(home, "rish"));
    fs.rmSync(path.join(home, "rish_shizuku.dex"));
    fs.rmSync(path.join(dl, "rish_shizuku.dex"));
    const partial = copyRishFiles();
    assert.equal(partial.ok, false);
    assert.equal(rishReady(), false, "rish alone is not enough, it needs the dex");
  } finally {
    if (original === undefined) delete process.env.HOME;
    else process.env.HOME = original;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("the rish copy route answers with a translation key, not a stack trace", async (t) => {
  fs.writeFileSync(
    process.env.TCA_CONFIG,
    JSON.stringify({ active: "", providers: {}, workspace: path.join(TMP, "ws") }),
  );
  const { server, port, token } = await serve({ port: 0, quiet: true });
  t.after(() => server.close());

  const res = await fetch(`http://127.0.0.1:${port}/api/privilege/copy-rish`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(res.status, 400, "there is no Shizuku export on a dev machine");
  const body = await res.json();
  assert.ok(body.errKey, "the UI needs a key it can translate");
  assert.ok(body.errKey in DICT.vi, `${body.errKey} has no Vietnamese text`);
});
