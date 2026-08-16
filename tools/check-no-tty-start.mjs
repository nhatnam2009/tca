/**
 * Start `tca serve` with a piped stdin and check it does not stop to ask.
 *
 * The prompt added to startup is the one thing in this project that can hang a
 * boot: Termux:Boot runs the daemon with no terminal, so if the question is not
 * gated on a TTY the phone comes up with no agent and no explanation. A unit
 * test can only assert the guard is in the source - this runs the real process.
 *
 * Second scenario: a saved address must actually be tried before anything else,
 * which is what makes a reboot free.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, "..", "src", "cli.js");

/**
 * Run the daemon until it prints its URL, then kill it.
 * @param {{port: string, saved?: string}} opts
 * @returns {Promise<{out: string, listening: boolean}>}
 */
async function startOnce({ port, saved }) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tca-notty-"));
  if (saved) {
    fs.writeFileSync(path.join(home, "adb.json"), JSON.stringify({ address: saved, savedAt: Date.now() }));
  }

  const child = spawn(process.execPath, [CLI, "serve", "--port", port], {
    // "pipe" for stdin is the whole point: process.stdin.isTTY is undefined
    // here, exactly as it is under Termux:Boot.
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      TERMUX_VERSION: "0.118.0",
      TCA_HOME: home,
      TCA_CONFIG: path.join(home, "config.json"),
    },
  });

  let out = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (c) => (out += c));
  child.stderr.on("data", (c) => (out += c));

  const started = Date.now();
  const listening = await new Promise((resolve) => {
    const timer = setInterval(() => {
      if (/listening on http/.test(out)) return clearInterval(timer), resolve(true);
      if (Date.now() - started > 25_000) return clearInterval(timer), resolve(false);
    }, 250);
  });

  child.kill("SIGKILL");
  fs.rmSync(home, { recursive: true, force: true });
  return { out: out.replace(/\x1b\[\d+m/g, ""), listening };
}

const problems = [];

// ---- 1. no terminal: explain and carry on ---------------------------------
const plain = await startOnce({ port: "8791" });
console.log("---- no TTY, nothing saved ----");
console.log(plain.out.trim());

if (!plain.listening) problems.push("the daemon never printed its URL - startup blocked or crashed");
if (!/No keyboard attached|Không có bàn phím/.test(plain.out)) {
  problems.push("it did not say why it skipped the prompt");
}
if (/\[Y\/n\]/.test(plain.out)) problems.push("it asked a question with no terminal attached");

// ---- 2. a saved address is tried first ------------------------------------
const remembered = await startOnce({ port: "8792", saved: "192.168.1.5:41235" });
console.log("\n---- no TTY, address saved ----");
console.log(remembered.out.trim());

if (!remembered.listening) problems.push("the daemon did not start when an address was saved");
if (!remembered.out.includes("192.168.1.5:41235")) {
  problems.push("the saved address was never mentioned, so it was probably never tried");
}
// adb does not exist here, so the attempt has to fail - and failing has to be
// reported as stale rather than swallowed.
if (!/no longer works|không còn dùng được/.test(remembered.out)) {
  problems.push("a failed reconnect should say the address looks stale");
}

console.log("");
if (problems.length) {
  for (const p of problems) console.error(`FAIL: ${p}`);
  process.exit(1);
}
console.log("OK: no prompt without a TTY, a saved address is tried first, and the daemon still comes up.");
