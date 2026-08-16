/**
 * Native search, when it is available.
 *
 * The grep tool walks the tree in JavaScript and reads every candidate file into
 * a string. That is fine on a laptop and slow on a phone: a few thousand files
 * is seconds per search, and the agent greps constantly.
 *
 * ripgrep and fd do the same job in native code, so use them when the device has
 * them and fall back to the JavaScript walk when it does not. The whole point is
 * that this is invisible: the two paths must return the same answers, or the
 * agent's behaviour would quietly depend on which packages are installed.
 *
 * Getting that parity right takes care, because the defaults disagree with us:
 *
 *   - ripgrep respects .gitignore and skips dotfiles. Our walk does not; it skips
 *     a fixed list of directories instead. So --no-ignore --hidden, plus an
 *     explicit exclude for each directory in that list.
 *   - ripgrep uses the Rust regex crate, which has no lookaround and no
 *     backreferences. A pattern using them would silently match differently, so
 *     those patterns go to the JavaScript path instead.
 *   - both honour the same maximum file size, so neither reports a hit the other
 *     would have skipped.
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

function run(file, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { timeout: TIMEOUT, maxBuffer: MAX_BUFFER, encoding: "utf8", ...opts },
      (error, stdout, stderr) => {
        resolve({
          code: error && typeof error.code === "number" ? error.code : error ? 1 : 0,
          killed: Boolean(error && (error.killed || error.signal)),
          out: String(stdout || ""),
          err: String(stderr || ""),
        });
      },
    );
  });
}

/** @param {"rg"|"fd"} bin */
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
 * fd, shaped to match the JavaScript glob walk.
 *
 * fd matches its pattern against the basename by default and takes a glob only
 * with --glob, so a pattern containing a slash needs --full-path as well.
 * @param {{
 *   root: string, pattern: string, limit: number,
 *   ignoreDirs: Set<string>|string[], signal?: AbortSignal,
 * }} o
 * @returns {Promise<{ok: true, files: string[]} | {ok: false, reason: string}>}
 */
export async function fdGlob(o) {
  if (!(await have("fd"))) return { ok: false, reason: "fd not installed" };

  const args = [
    "--type", "f",
    "--glob",
    "--no-ignore",
    "--hidden",
    "--color", "never",
    ...excludeArgs(o.ignoreDirs),
  ];
  if (o.pattern.includes("/")) args.push("--full-path");
  args.push(o.pattern, ".");

  const r = await run("fd", args, { cwd: o.root, signal: o.signal });
  if (r.killed) return { ok: false, reason: "fd timed out" };
  if (r.code !== 0) return { ok: false, reason: r.err.trim().slice(0, 200) || `fd exit ${r.code}` };

  const files = [];
  for (const raw of r.out.split("\n")) {
    if (!raw) continue;
    files.push(raw.replace(/^\.[\\/]/, "").split("\\").join("/"));
    if (files.length >= o.limit) break;
  }
  return { ok: true, files };
}
