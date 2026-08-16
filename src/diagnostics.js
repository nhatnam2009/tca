/**
 * Diagnostics: does the code the agent just wrote actually parse and typecheck?
 *
 * This is the cheap stand-in for the LSP diagnostics a desktop coding agent gets,
 * and it closes the single largest quality gap. Without it the loop is:
 *
 *   edit -> "Done, I updated the handler." -> [the file does not compile]
 *
 * and the agent has no way to know, because nothing told it. It only finds out if
 * the user happens to run the build, which on a phone they often will not.
 *
 * Deliberately NOT a language server. tsserver on a phone costs hundreds of
 * megabytes of RAM, takes tens of seconds to index, and gets killed by Android's
 * low-memory killer mid-answer. Running the checker the project already has,
 * scoped to the file that changed, gets most of the value for a fraction of the
 * cost - and it needs no configuration, because a project that can be built has
 * already told us how.
 *
 * Rules this follows:
 *   - Only report a problem when a checker is actually available. Never guess.
 *   - Errors in the file just touched come first; other files are counted, not
 *     dumped, so one broken import does not bury the actual message.
 *   - A checker that times out reports that it timed out. Silence would read as
 *     "no errors", which is the one wrong answer.
 */

import fs from "node:fs";
import path from "node:path";
import { run, hasCommand } from "./exec.js";

/** A per-edit hook has to stay out of the way; the whole-project ones get more. */
const FAST_TIMEOUT = 25_000;
const PROJECT_TIMEOUT = 90_000;
const MAX_REPORT = 4_000;
const MAX_OTHER_FILES = 5;

/** @typedef {{checker: string, ok: boolean, report: string}} Diagnosis */

/**
 * Group of files that one checker invocation can handle.
 * @typedef {{id: string, files: string[]}} Group
 */

const EXT_GROUP = {
  ".js": "node",
  ".mjs": "node",
  ".cjs": "node",
  ".jsx": "tsc",
  ".ts": "tsc",
  ".tsx": "tsc",
  ".mts": "tsc",
  ".cts": "tsc",
  ".json": "json",
  ".py": "python",
  ".go": "go",
  ".sh": "sh",
  ".bash": "sh",
};

/**
 * Check the files that just changed.
 *
 * @param {object} args
 * @param {string} args.workspace
 * @param {string[]} args.files        workspace-relative paths
 * @param {AbortSignal} [args.signal]
 * @returns {Promise<Diagnosis[]>}  only entries worth telling the model about
 */
export async function diagnose({ workspace, files, signal }) {
  /** @type {Map<string, string[]>} */
  const groups = new Map();
  for (const rel of files) {
    const id = EXT_GROUP[path.extname(rel).toLowerCase()];
    if (!id) continue;
    if (!fs.existsSync(path.join(workspace, rel))) continue; // deleted, nothing to check
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(rel);
  }

  /** @type {Diagnosis[]} */
  const out = [];
  for (const [id, group] of groups) {
    try {
      const result = await CHECKERS[id]({ workspace, files: group, signal });
      if (result) out.push(result);
    } catch {
      // A broken checker must never break the edit that triggered it.
    }
  }
  return out;
}

/**
 * Render diagnoses as a tool-result suffix.
 *
 * Framed as a check that ran rather than as prose, so the model treats it as
 * evidence about its own edit and not as a new instruction.
 * @param {Diagnosis[]} list
 */
export function formatDiagnoses(list) {
  if (!list.length) return "";
  const parts = [];
  for (const d of list) {
    parts.push(d.ok ? `✓ ${d.checker}: clean` : `✗ ${d.checker}:\n${d.report}`);
  }
  return `\n\n--- checked after this change ---\n${parts.join("\n")}`;
}

// ------------------------------------------------------------------- checkers

/** @type {Record<string, (a: {workspace: string, files: string[], signal?: AbortSignal}) => Promise<Diagnosis|null>>} */
const CHECKERS = {
  /**
   * Syntax only, but it is the error that matters most: a file that does not
   * parse breaks everything downstream, and `node --check` is free and always
   * present because the agent itself runs on Node.
   */
  async node({ workspace, files, signal }) {
    const bad = [];
    for (const rel of files) {
      const { code, output } = await run({
        command: `node --check ${quote(rel)}`,
        cwd: workspace,
        timeout: FAST_TIMEOUT,
        signal,
      });
      if (code !== 0 && output) bad.push(trimNodeCheck(output, rel));
    }
    if (!bad.length) return { checker: "node --check", ok: true, report: "" };
    return { checker: "node --check", ok: false, report: clip(bad.join("\n\n")) };
  },

  /**
   * The whole project, because that is the only mode tsc has that respects
   * tsconfig.json - and tsconfig is where paths, JSX and lib settings live, so
   * checking a single file without it produces errors that are not real.
   *
   * Skipped entirely when there is no tsconfig.json: a loose .ts file with no
   * project would be checked under defaults nobody chose.
   */
  async tsc({ workspace, files, signal }) {
    if (!fs.existsSync(path.join(workspace, "tsconfig.json"))) return null;
    const local = path.join(workspace, "node_modules", ".bin", process.platform === "win32" ? "tsc.cmd" : "tsc");
    const cmd = fs.existsSync(local) ? quote(local) : (await hasCommand("tsc")) ? "tsc" : null;
    if (!cmd) return null;

    const { code, output, timedOut } = await run({
      command: `${cmd} --noEmit --pretty false`,
      cwd: workspace,
      timeout: PROJECT_TIMEOUT,
      signal,
    });
    if (timedOut) {
      return { checker: "tsc --noEmit", ok: false, report: `timed out after ${PROJECT_TIMEOUT / 1000}s, so the types are unverified` };
    }
    if (code === 0) return { checker: "tsc --noEmit", ok: true, report: "" };
    return { checker: "tsc --noEmit", ok: false, report: focus(output, files) };
  },

  /** No spawn at all: the parser is right here and JSON has no other checker. */
  async json({ workspace, files }) {
    const bad = [];
    for (const rel of files) {
      try {
        JSON.parse(fs.readFileSync(path.join(workspace, rel), "utf8"));
      } catch (err) {
        bad.push(`${rel}: ${/** @type {Error} */ (err).message}`);
      }
    }
    if (!bad.length) return { checker: "JSON parse", ok: true, report: "" };
    return { checker: "JSON parse", ok: false, report: clip(bad.join("\n")) };
  },

  /** ruff when the project has it, otherwise the compiler that ships with Python. */
  async python({ workspace, files, signal }) {
    const list = files.map(quote).join(" ");
    if (await hasCommand("ruff")) {
      const { code, output } = await run({
        command: `ruff check --no-cache --output-format concise ${list}`,
        cwd: workspace,
        timeout: FAST_TIMEOUT,
        signal,
      });
      if (code === 0) return { checker: "ruff", ok: true, report: "" };
      return { checker: "ruff", ok: false, report: clip(output) };
    }
    const python = (await hasCommand("python3")) ? "python3" : (await hasCommand("python")) ? "python" : null;
    if (!python) return null;
    const { code, output } = await run({
      command: `${python} -m py_compile ${list}`,
      cwd: workspace,
      timeout: FAST_TIMEOUT,
      signal,
    });
    if (code === 0) return { checker: "py_compile", ok: true, report: "" };
    return { checker: "py_compile", ok: false, report: clip(output) };
  },

  /** gofmt -e reports syntax errors and costs nothing; go build would be minutes. */
  async go({ workspace, files, signal }) {
    if (!(await hasCommand("gofmt"))) return null;
    const { code, output } = await run({
      command: `gofmt -l -e ${files.map(quote).join(" ")}`,
      cwd: workspace,
      timeout: FAST_TIMEOUT,
      signal,
    });
    // gofmt -l also lists merely unformatted files, which is not an error worth
    // interrupting an edit for. Only a parse error writes to stderr with a colon
    // position, so look for that shape.
    const real = output.split("\n").filter((l) => /:\d+:\d+:/.test(l));
    if (code === 0 && !real.length) return { checker: "gofmt -e", ok: true, report: "" };
    if (!real.length) return null;
    return { checker: "gofmt -e", ok: false, report: clip(real.join("\n")) };
  },

  async sh({ workspace, files, signal }) {
    if (!(await hasCommand("bash"))) return null;
    const bad = [];
    for (const rel of files) {
      const { code, output } = await run({
        command: `bash -n ${quote(rel)}`,
        cwd: workspace,
        timeout: FAST_TIMEOUT,
        signal,
      });
      if (code !== 0 && output) bad.push(output);
    }
    if (!bad.length) return { checker: "bash -n", ok: true, report: "" };
    return { checker: "bash -n", ok: false, report: clip(bad.join("\n")) };
  },
};

// -------------------------------------------------------------------- helpers

/**
 * Put the errors in the files we just touched first, and count the rest.
 *
 * A project-wide typecheck after one edit often returns errors that were already
 * there. Dumping all of them buries the one line the model needs and spends
 * thousands of tokens doing it.
 * @param {string} output
 * @param {string[]} files
 */
function focus(output, files) {
  const wanted = new Set(files.map((f) => f.replace(/\\/g, "/")));
  const lines = output.split("\n").filter((l) => l.trim());
  /** @type {string[]} */
  const mine = [];
  /** @type {Set<string>} */
  const otherFiles = new Set();
  let otherCount = 0;

  for (const line of lines) {
    const m = /^(.+?)\((\d+),(\d+)\)/.exec(line) || /^(.+?):(\d+):(\d+)/.exec(line);
    const file = m ? m[1].replace(/\\/g, "/") : "";
    if (file && wanted.has(file)) mine.push(line);
    else if (file) {
      otherFiles.add(file);
      otherCount++;
    } else if (mine.length) mine.push(line); // continuation of the previous error
  }

  const parts = [];
  if (mine.length) parts.push(mine.join("\n"));
  else if (otherCount) parts.push("(no errors in the file just changed)");
  if (otherCount) {
    const names = [...otherFiles].slice(0, MAX_OTHER_FILES);
    const more = otherFiles.size - names.length;
    parts.push(
      `${otherCount} pre-existing error(s) elsewhere: ${names.join(", ")}${more > 0 ? ` and ${more} more file(s)` : ""}`,
    );
  }
  return clip(parts.join("\n\n") || output);
}

/** node --check prints the offending source plus a stack; only the top is useful. */
function trimNodeCheck(output, rel) {
  const lines = output.split("\n");
  const stackAt = lines.findIndex((l) => /^\s+at\s/.test(l));
  const body = (stackAt > 0 ? lines.slice(0, stackAt) : lines).join("\n").trim();
  return body.includes(rel) ? body : `${rel}\n${body}`;
}

function clip(text) {
  const t = (text || "").trim();
  if (t.length <= MAX_REPORT) return t;
  return `${t.slice(0, MAX_REPORT)}\n[... ${t.length - MAX_REPORT} more characters ...]`;
}

/** Quote a path for the shell. Paths come from the model, so this is not optional. */
function quote(p) {
  if (process.platform === "win32") return `"${p.replace(/"/g, '""')}"`;
  return `'${p.replace(/'/g, `'\\''`)}'`;
}
