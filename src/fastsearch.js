/**
 * Native search, when it is available.
 *
 * The grep and glob tools walk the tree in JavaScript and read every candidate
 * file into a string. That is fine on a laptop and slow on a phone: a few thousand
 * files is seconds per search, and the agent searches constantly.
 *
 * ripgrep does the same job in native code, so use it when the device has it and
 * fall back to the JavaScript walk when it does not. The whole point is that this
 * is invisible: the two paths must return the same answers, or the agent's
 * behaviour would quietly depend on which packages are installed.
 *
 * Getting that parity right takes care, because the defaults disagree with us:
 *
 *   - ripgrep respects .gitignore and skips dotfiles. Our walk does not; it skips
 *     a fixed list of directories instead. So --no-ignore --hidden, plus an
 *     explicit exclude for each directory in that list.
 *   - ripgrep uses the Rust regex crate, which has no lookaround and no
 *     backreferences. A pattern using them would silently match differently, so
 *     those patterns go to the JavaScript path instead.
 *   - a glob with no `/` matches at any depth in gitignore semantics, but only in
 *     the current directory in the minimatch semantics our walk implements. So a
 *     slash-free pattern gets --max-depth 1.
 *   - both honour the same maximum file size, so neither reports a hit the other
 *     would have skipped.
 *
 * Glob used to go through fd, and it was wrong in three ways at once - see rgGlob
 * for what happened and why ripgrep does both jobs now.
 *
 * Anything unexpected - a non-zero exit that is not "no matches", a timeout, a
 * binary that turns out to be something else - returns { ok: false } and the
 * caller uses the JavaScript path. Never a hard failure.
 */

import { execFile } from "node:child_process";

const TIMEOUT = 30_000;
const MAX_BUFFER = 8 * 1024 * 1024;

/**
 * Constructs the Rust regex crate does not support. A pattern containing any of
 * them has to go to JavaScript, or the two paths would disagree.
 */
const JS_ONLY = /\(\?<[=!]|\(\?[=!]|\\[1-9]|\(\?<[A-Za-z]/;

/** @param {string} pattern */
export function needsJsRegex(pattern) {
  return JS_ONLY.test(String(pattern));
}

/** Detected once per process: these binaries do not appear and disappear. */
const found = new Map();

/**
 * @returns {Promise<{code: number, killed: boolean, spawnFailed: boolean, out: string, err: string}>}
 */
function run(file, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { timeout: TIMEOUT, maxBuffer: MAX_BUFFER, encoding: "utf8", ...opts },
      (error, stdout, stderr) => {
        const numeric = error && typeof error.code === "number";
        const killed = Boolean(error && (error.killed || error.signal));
        resolve({
          code: numeric ? /** @type {number} */ (error.code) : error ? 1 : 0,
          killed,
          // A process that never started is not a process that exited 1. execFile
          // reports both through the same callback, with a *string* code like
          // ENOENT for the former, and collapsing them meant a bad cwd or a
          // missing binary came back as "no matches" - an answer the caller cannot
          // tell apart from a real empty result, so it never fell back.
          spawnFailed: Boolean(error) && !numeric && !killed,
          out: String(stdout || ""),
          err: String(stderr || ""),
        });
      },
    );
  });
}

/** @param {"rg"} bin */
export async function have(bin) {
  // An escape hatch, and the thing that makes the parity test possible: run the
  // same search twice, once with this set, and the two answers must match.
  if (process.env.TCA_NO_FASTSEARCH) return false;
  if (found.has(bin)) return found.get(bin);
  // --version rather than `which`: a binary that is on PATH but will not run
  // (the Termux libc++ mismatch) must count as absent, not as present.
  const r = await run(bin, ["--version"], { timeout: 5000 });
  const ok = r.code === 0 && /\d+\.\d+/.test(r.out);
  found.set(bin, ok);
  return ok;
}

/** Only for tests: forget what was detected. */
export function resetProbes() {
  found.clear();
}

/**
 * @param {Set<string>|string[]} ignoreDirs
 * @returns {string[]} one --glob exclusion per ignored directory
 */
function excludeArgs(ignoreDirs) {
  const args = [];
  for (const dir of ignoreDirs) args.push("--glob", `!${dir}/`);
  return args;
}

/** Paths come back as `./x` on Unix and `.\x` on Windows; the walk yields neither. */
function normalise(raw) {
  return raw.replace(/^\.[\\/]/, "").split("\\").join("/");
}

/**
 * ripgrep, shaped to match the JavaScript grep exactly.
 * @param {{
 *   root: string, pattern: string, include?: string, maxResults: number,
 *   maxFileSize: number, ignoreDirs: Set<string>|string[], signal?: AbortSignal,
 * }} o
 * @returns {Promise<{ok: true, lines: string[]} | {ok: false, reason: string}>}
 */
export async function rgSearch(o) {
  if (needsJsRegex(o.pattern)) return { ok: false, reason: "pattern needs JavaScript regex features" };
  if (!(await have("rg"))) return { ok: false, reason: "ripgrep not installed" };

  const args = [
    "--line-number",
    "--no-heading",
    "--with-filename",
    "--color", "never",
    "--no-messages",       // a permission error on one file must not fail the search
    "--no-ignore",         // our walk does not read .gitignore
    "--hidden",            // ... and does not skip dotfiles
    "--max-filesize", String(o.maxFileSize),
    ...excludeArgs(o.ignoreDirs),
  ];
  if (o.include) args.push("--glob", o.include);
  args.push("--regexp", o.pattern, ".");

  const r = await run("rg", args, { cwd: o.root, signal: o.signal });
  // 0 = matches, 1 = none, 2 = a real error. Only the first two are answers.
  if (r.spawnFailed) return { ok: false, reason: r.err.trim().slice(0, 200) || "ripgrep would not start" };
  if (r.killed) return { ok: false, reason: "ripgrep timed out" };
  if (r.code === 1) return { ok: true, lines: [] };
  if (r.code !== 0) return { ok: false, reason: r.err.trim().slice(0, 200) || `ripgrep exit ${r.code}` };

  const lines = [];
  for (const raw of r.out.split("\n")) {
    if (!raw) continue;
    // path:line:text - the path may itself contain a colon, so split on the
    // first two only, and the line number is what proves we found the boundary.
    const first = raw.indexOf(":");
    if (first === -1) continue;
    const second = raw.indexOf(":", first + 1);
    if (second === -1) continue;
    const file = raw.slice(0, first).replace(/^\.[\\/]/, "").split("\\").join("/");
    const lineNo = raw.slice(first + 1, second);
    if (!/^\d+$/.test(lineNo)) continue;
    const text = raw.slice(second + 1);
    lines.push(`${file}:${lineNo}: ${text.slice(0, 400)}`);
    if (lines.length >= o.maxResults) break;
  }
  return { ok: true, lines };
}

/**
 * Glob, through `rg --files`.
 *
 * This used to go through fd, and fd was wrong in three independent ways at once.
 * All three surfaced as "no files match", which is the worst possible symptom: it
 * is indistinguishable from a real empty result, so nothing fell back and the agent
 * was told the file it was looking for did not exist.
 *
 *   1. The exclusion flags were ripgrep's. In ripgrep `--glob` takes a value and a
 *      leading `!` negates it; in fd `--glob` is a boolean switch and exclusions
 *      are `--exclude`. So `--glob '!node_modules/'` left `!node_modules/` as a
 *      positional, and fd read it as the search *pattern* and read the real
 *      pattern as a search *path*: `[fd error]: Search path '!.git/' is not a
 *      directory`. Every glob with a non-empty ignore list was broken.
 *   2. `--full-path` matches against the path as fd prints it - `./`-prefixed and
 *      platform-separated - while the walk yields `/`-separated relative paths. So
 *      `src/**\/*.js` matched nothing, and against fd 10.4.2 every way round it
 *      failed too: `./src/...`, `**\/src/...`, `--strip-cwd-prefix`.
 *   3. Without `--full-path`, fd matches the basename at *any* depth, so `*.js`
 *      returned `src/deep/a.js` while the walk correctly returned only top-level
 *      files.
 *
 * ripgrep needs one correction instead of three, and it is the one this module was
 * already built around. `rg --glob` implements real relative-path glob matching,
 * verified to agree with the walk on all three shapes: `*.js` (top level only, via
 * --max-depth 1), `**\/*.js` (recursive) and `src/*.js` (one level under src).
 *
 * The remaining difference is that gitignore semantics let a slash-free pattern
 * match at any depth, where minimatch - which the walk implements, and which is
 * what the tool's description promises - keeps it in the current directory. Hence
 * --max-depth 1 for a pattern with no separator.
 *
 * @param {{
 *   root: string, pattern: string, limit: number,
 *   ignoreDirs: Set<string>|string[], signal?: AbortSignal,
 * }} o
 * @returns {Promise<{ok: true, files: string[]} | {ok: false, reason: string}>}
 */
export async function rgGlob(o) {
  if (!(await have("rg"))) return { ok: false, reason: "ripgrep not installed" };

  const args = [
    "--files",
    "--color", "never",
    "--no-messages",
    "--no-ignore",
    "--hidden",
    ...excludeArgs(o.ignoreDirs),
  ];
  if (!String(o.pattern).includes("/")) args.push("--max-depth", "1");
  args.push("--glob", o.pattern, ".");

  const r = await run("rg", args, { cwd: o.root, signal: o.signal });
  if (r.spawnFailed) return { ok: false, reason: r.err.trim().slice(0, 200) || "ripgrep would not start" };
  if (r.killed) return { ok: false, reason: "ripgrep timed out" };
  // 1 means nothing matched, which is an answer, not a failure.
  if (r.code === 1) return { ok: true, files: [] };
  if (r.code !== 0) return { ok: false, reason: r.err.trim().slice(0, 200) || `ripgrep exit ${r.code}` };

  // --files output has no field structure to misparse, but sort it: the walk sorts,
  // and an unsorted list would truncate to a different set at the limit.
  const files = [];
  for (const raw of r.out.split("\n")) {
    if (!raw) continue;
    files.push(normalise(raw));
  }
  files.sort();
  return { ok: true, files: files.slice(0, o.limit) };
}
