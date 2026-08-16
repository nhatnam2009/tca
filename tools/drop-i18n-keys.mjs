/**
 * Remove i18n keys, line-accurately.
 *
 * A regex over the whole file got this wrong: some entries wrap onto a second
 * line, and a pattern loose enough to catch those also ate the line after a
 * single-line entry, leaving a dangling string literal. This walks lines instead,
 * and only treats the next line as a continuation when the current line does not
 * already close the entry.
 */
import fs from "node:fs";

const file = new URL("../src/i18n.js", import.meta.url);
const dead = new Set(process.argv.slice(2));
if (!dead.size) {
  console.error("usage: node tools/drop-i18n-keys.mjs key.one key.two ...");
  process.exit(1);
}

const lines = fs.readFileSync(file, "utf8").split("\n");
/** @type {string[]} */
const out = [];
const removed = new Set();

for (let i = 0; i < lines.length; i++) {
  const m = /^\s*"([a-zA-Z0-9_.]+)":/.exec(lines[i]);
  if (!m || !dead.has(m[1])) {
    out.push(lines[i]);
    continue;
  }
  removed.add(m[1]);
  // An entry ends on the line that closes it with a comma. If this line does not,
  // the value wrapped, so keep dropping until one does.
  let line = lines[i];
  while (!/,\s*$/.test(line.trimEnd()) && i + 1 < lines.length) {
    i += 1;
    line = lines[i];
  }
}

fs.writeFileSync(file, out.join("\n"));
const missing = [...dead].filter((k) => !removed.has(k));
console.log(`removed ${removed.size} key(s), ${lines.length - out.length} line(s)`);
if (missing.length) console.log(`not found: ${missing.join(", ")}`);
