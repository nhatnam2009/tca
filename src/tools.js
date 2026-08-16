/**
 * Agent tools.
 *
 * Two safety rails, both mandatory:
 *   1. Every filesystem path is resolved and must land inside config.workspace.
 *      Symlinks are followed before the check, so a link out of the tree fails.
 *   2. run_command consults an approval callback unless autoApproveCommands is
 *      on, and a denylist that no setting can switch off.
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { run as execRun, pickShell } from "./exec.js";
import { rgGlob, rgSearch } from "./fastsearch.js";
import { writeTodos } from "./store.js";
import { search as webSearch } from "./websearch.js";
import { diagnose, formatDiagnoses } from "./diagnostics.js";
import { recordFileChange } from "./undo.js";

export { pickShell };

const MAX_OUTPUT = 60_000; // chars fed back to the model
const MAX_FILE = 400_000;
const DEFAULT_TIMEOUT = 120_000;
// Collected before sorting, so the two grep implementations truncate the same
// list rather than two different prefixes of it.
const MAX_GREP_LINES = 5_000;
const GLOB_LIMIT = 20_000;
/**
 * Directories neither search path ever descends into.
 *
 * Exported so the parity tests can pass the real list rather than a copy of it: a
 * copy that drifts would make the tests agree with each other while disagreeing
 * with the tool, which is worse than having no test.
 */
export const IGNORE_DIRS = new Set([
  ".git",
  "node_modules",
  ".cache",
  "dist",
  "build",
  "target",
  ".venv",
  "__pycache__",
  ".next",
]);

/** Blocked no matter what the config says. */
const HARD_DENY = [
  /\brm\s+(-[a-z]*\s+)*-[a-z]*[rf][a-z]*\s+\/(\s|$)/, // rm -rf /
  /\bmkfs(\.\w+)?\b/,
  /\bdd\b[^\n]*\bof=\/dev\//,
  /\b(shutdown|reboot|halt|poweroff)\b/,
  /:\s*\(\s*\)\s*\{.*\}\s*;\s*:/, // fork bomb
  />\s*\/dev\/(sd|mmcblk|block)/,
  /\bchmod\s+(-R\s+)?777\s+\/(\s|$)/,
  /\b(curl|wget)\b[^\n|]*\|\s*(sudo\s+)?(ba)?sh\b/, // pipe-to-shell
  /\bgit\s+push\b[^\n]*(--force\b|(?<!-)-f\b)(?![a-z-])/,
  /\bgit\s+reset\s+--hard\b/,
  /\bgit\s+clean\s+[^\n]*-[a-z]*f/,
];

/** Commands that get an approval prompt even when auto-approve is off-limits. */
const WRITES_OUTSIDE = /\b(sudo|su|pkg|apt|npm|pnpm|yarn|pip|cargo|go)\s+(install|add|remove|uninstall|upgrade|i)\b/;

export class ToolError extends Error {}

/**
 * @typedef {object} ToolContext
 * @property {string} workspace                     absolute, already created
 * @property {boolean} autoApproveCommands
 * @property {boolean} [autoApproveEdits]           false = confirm every file write
 * @property {boolean} [verifyEdits]                false = do not run checkers after a write
 * @property {"build"|"plan"} [mode]
 * @property {string[]} [denyCommands]              extra regex sources
 * @property {string} [sessionId]                   needed by todo_write
 * @property {(items: Array<{text: string, status: string}>) => void} [onTodo]
 * @property {(req: {command: string, cwd: string, reason: string, kind?: "command"|"edit"}) => Promise<boolean>} approve
 * @property {(args: {prompt: string, kind: string}) => Promise<string>} [spawnAgent]  runs a sub-agent
 * @property {(note: string) => void} [onNote]      surface something in the UI transcript
 * @property {AbortSignal} [signal]
 */

// ------------------------------------------------------------ path confinement

/**
 * Resolve a model-supplied path inside the workspace, or throw.
 * @param {ToolContext} ctx
 * @param {string} p
 */
function resolveInside(ctx, p) {
  if (typeof p !== "string" || !p.length) throw new ToolError("path is required");
  const abs = path.resolve(ctx.workspace, p);
  const root = realpathOrSelf(ctx.workspace);
  const target = realpathOrSelf(abs);
  const rel = path.relative(root, target);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new ToolError(`path escapes the workspace (${ctx.workspace}): ${p}`);
  }
  return abs;
}

function realpathOrSelf(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    // File does not exist yet - check its closest existing ancestor instead.
    const parent = path.dirname(p);
    if (parent === p) return p;
    return path.join(realpathOrSelf(parent), path.basename(p));
  }
}

function clip(text, limit = MAX_OUTPUT) {
  if (text.length <= limit) return text;
  const cut = text.length - limit;
  return `${text.slice(0, limit)}\n\n[... ${cut} more characters truncated ...]`;
}

// -------------------------------------------------------------- glob matching

/** Translate a glob to a regex. Supports **, *, ?, {a,b} and character classes. */
function globToRegExp(pattern) {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        // ** spans separators; **/ also matches zero directories
        i++;
        if (pattern[i + 1] === "/") {
          i++;
          re += "(?:.*/)?";
        } else {
          re += ".*";
        }
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") re += "[^/]";
    else if (c === "{") re += "(?:";
    else if (c === "}") re += ")";
    else if (c === ",") re += "|";
    else if (c === "[") {
      const close = pattern.indexOf("]", i);
      if (close === -1) re += "\\[";
      else {
        re += pattern.slice(i, close + 1).replace("[!", "[^");
        i = close;
      }
    } else re += c.replace(/[.+^$()|\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

/**
 * @param {string} root
 * @param {(relPath: string, entry: fs.Dirent) => void} visit
 * @param {number} [limit]
 */
async function walk(root, visit, limit = 20_000) {
  let seen = 0;
  /** @type {string[]} */
  const queue = [""];
  while (queue.length) {
    const rel = queue.shift();
    /** @type {fs.Dirent[]} */
    let entries;
    try {
      entries = await fsp.readdir(path.join(root, rel), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (seen >= limit) return;
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (IGNORE_DIRS.has(entry.name)) continue;
        queue.push(childRel);
      } else {
        seen++;
        visit(childRel, entry);
      }
    }
  }
}

// ------------------------------------------------------------- unified diff

/**
 * Parse the hunks of a unified diff.
 *
 * Only the hunk bodies matter; ---/+++/index/diff header lines are skipped.
 * Each op keeps its tag so the original interleaving survives - collapsing a
 * hunk into "all removals then all additions" reorders the file, which is how
 * the first version of this corrupted files.
 * @param {string} diff
 * @returns {Array<{start: number, ops: Array<[" "|"-"|"+", string]>}>}
 */
function parseHunks(diff) {
  const lines = diff.replace(/\r\n?/g, "\n").split("\n");
  // A diff string normally ends with a newline, which split() turns into a
  // trailing "". That is not a context line - counting it as one makes every
  // hunk one line too long and nothing matches.
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  /** @type {Array<{start: number, ops: Array<[" "|"-"|"+", string]>}>} */
  const hunks = [];
  let cur = null;
  for (const line of lines) {
    const header = /^@@+ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (header) {
      cur = { start: parseInt(header[1], 10), ops: [] };
      hunks.push(cur);
      continue;
    }
    if (!cur) continue; // preamble before the first hunk
    if (line.startsWith("\\")) continue; // "\ No newline at end of file"
    const tag = line[0];
    if (tag === " " || tag === "-" || tag === "+") cur.ops.push([tag, line.slice(1)]);
    else if (line === "") cur.ops.push([" ", ""]); // context line whose leading space was trimmed
    else cur = null; // trailing prose after the diff body
  }
  return hunks;
}

/**
 * Locate `before` in `lines`, preferring `hint` and searching outwards.
 * Returns -1 when the file does not contain that text at all.
 */
function findHunk(lines, before, hint) {
  if (!before.length) return Math.min(Math.max(hint, 0), lines.length);
  const fits = (i) => i >= 0 && i + before.length <= lines.length;
  const matches = (i) => before.every((l, k) => lines[i + k] === l);
  const start = Math.min(Math.max(hint, 0), lines.length);
  if (fits(start) && matches(start)) return start;
  for (let d = 1; d <= lines.length; d++) {
    if (fits(start - d) && matches(start - d)) return start - d;
    if (fits(start + d) && matches(start + d)) return start + d;
  }
  return -1;
}

/**
 * Apply a unified diff to text. Refuses rather than guesses: if a hunk's
 * context/removed lines are not in the file, nothing is written.
 * @param {string} original
 * @param {string} diff
 * @returns {{text: string, applied: number, shifted: number}}
 */
export function applyUnifiedDiff(original, diff) {
  const hunks = parseHunks(diff);
  if (!hunks.length) {
    throw new ToolError("no @@ hunk headers found in diff; patch_file needs unified diff format");
  }

  // Preserve the file's own line endings and trailing newline.
  const eol = original.includes("\r\n") ? "\r\n" : "\n";
  const hadTrailingNewline = /\n$/.test(original);
  const lines = original.replace(/\r\n?/g, "\n").split("\n");
  if (hadTrailingNewline) lines.pop(); // "a\n" -> ["a"], not ["a", ""]

  let offset = 0;
  let shifted = 0;
  for (const [n, hunk] of hunks.entries()) {
    const before = hunk.ops.filter(([t]) => t !== "+").map(([, s]) => s);
    const after = hunk.ops.filter(([t]) => t !== "-").map(([, s]) => s);
    const hint = hunk.start - 1 + offset;
    const at = findHunk(lines, before, hint);
    if (at === -1) {
      const sample = before.find((l) => l.trim()) || "(blank lines only)";
      throw new ToolError(
        `hunk ${n + 1} (@@ -${hunk.start}) does not match the file. ` +
          `Read the file again and rebuild the diff. First unmatched line: ${JSON.stringify(sample.slice(0, 120))}`,
      );
    }
    if (at !== hint) shifted++;
    lines.splice(at, before.length, ...after);
    offset += after.length - before.length;
  }

  const text = lines.join(eol) + (hadTrailingNewline ? eol : "");
  return { text, applied: hunks.length, shifted };
}

/**
 * A compact unified diff of what a write actually changed.
 *
 * Deliberately not a real LCS diff: it trims the common prefix and suffix and
 * reports the middle as one hunk. That is O(n), which matters on a phone, and it
 * covers the shape of an edit_file/patch_file change well. The result goes back
 * to the model too, so it can see the effect of its own edit.
 * @param {string} before
 * @param {string} after
 * @param {number} [maxLines]
 * @returns {string} "" when the two are identical
 */
export function changeSummary(before, after, maxLines = 40) {
  if (before === after) return "";
  const a = before.replace(/\r\n?/g, "\n").split("\n");
  const b = after.replace(/\r\n?/g, "\n").split("\n");

  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) {
    tail++;
  }

  const removed = a.slice(head, a.length - tail);
  const added = b.slice(head, b.length - tail);
  const CONTEXT = 2;
  const ctxBefore = a.slice(Math.max(0, head - CONTEXT), head);
  const ctxAfter = a.slice(a.length - tail, Math.min(a.length, a.length - tail + CONTEXT));

  /** @type {string[]} */
  const out = [`@@ -${head + 1},${removed.length} +${head + 1},${added.length} @@`];
  for (const l of ctxBefore) out.push(` ${l}`);
  let shown = 0;
  for (const l of removed) {
    if (shown++ >= maxLines) break;
    out.push(`-${l}`);
  }
  for (const l of added) {
    if (shown++ >= maxLines) break;
    out.push(`+${l}`);
  }
  const hidden = removed.length + added.length - Math.min(shown, maxLines);
  for (const l of ctxAfter) out.push(` ${l}`);
  if (hidden > 0) out.push(`[... ${hidden} more changed line(s) ...]`);
  return out.join("\n");
}

/**
 * Shared tail of both grep implementations.
 *
 * Sorting before truncating is what makes the ripgrep path and the JavaScript
 * path interchangeable: they visit files in different orders, so cutting to
 * max_results first would hand back two different subsets of the same matches.
 * @param {string[]} lines  "path:line: text"
 * @param {string} pattern
 * @param {number} maxResults
 */
function formatGrep(lines, pattern, maxResults) {
  if (!lines.length) return `no matches for ${pattern}`;
  const parsed = lines.map((raw) => {
    const first = raw.indexOf(":");
    const second = raw.indexOf(":", first + 1);
    return { file: raw.slice(0, first), line: Number(raw.slice(first + 1, second)) || 0, raw };
  });
  parsed.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line));
  const shown = parsed.slice(0, Math.max(1, maxResults));
  const more = parsed.length - shown.length;
  const body = shown.map((x) => x.raw).join("\n");
  return clip(more > 0 ? `${body}\n[... ${more} more match(es); raise max_results ...]` : body);
}

// -------------------------------------------------------------------- the tools/** @type {Record<string, {spec: import("./provider.js").ToolSpec, run: (args: any, ctx: ToolContext) => Promise<string>}>} */
export const TOOLS = {
  read_file: {
    spec: {
      name: "read_file",
      description:
        "Read a UTF-8 text file from the workspace. Returns the file with 1-based line numbers prefixed. Use offset/limit for large files.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path relative to the workspace root." },
          offset: { type: "integer", description: "First line to return, 1-based." },
          limit: { type: "integer", description: "Maximum number of lines." },
        },
        required: ["path"],
      },
    },
    async run({ path: p, offset = 1, limit = 2000 }, ctx) {
      const abs = resolveInside(ctx, p);
      const stat = await fsp.stat(abs).catch(() => null);
      if (!stat) throw new ToolError(`no such file: ${p}`);
      if (stat.isDirectory()) throw new ToolError(`${p} is a directory, use list_dir`);
      if (stat.size > MAX_FILE) throw new ToolError(`file too large (${stat.size} bytes)`);
      const text = await fsp.readFile(abs, "utf8");
      const lines = text.split("\n");
      const start = Math.max(1, offset);
      const slice = lines.slice(start - 1, start - 1 + limit);
      if (!slice.length) return `[empty range; file has ${lines.length} lines]`;
      const numbered = slice.map((l, i) => `${start + i}: ${l}`).join("\n");
      const tail =
        start - 1 + slice.length < lines.length
          ? `\n[... ${lines.length - (start - 1 + slice.length)} more lines ...]`
          : "";
      return clip(numbered + tail);
    },
  },

  write_file: {
    spec: {
      name: "write_file",
      description:
        "Create a file or overwrite it completely. Parent directories are created. Prefer edit_file for changing part of an existing file.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string" },
        },
        required: ["path", "content"],
      },
    },
    async run({ path: p, content }, ctx) {
      const abs = resolveInside(ctx, p);
      if (typeof content !== "string") throw new ToolError("content must be a string");
      await fsp.mkdir(path.dirname(abs), { recursive: true });
      const previous = await fsp.readFile(abs, "utf8").catch(() => null);
      await fsp.writeFile(abs, content, "utf8");
      if (ctx.sessionId) {
        await recordFileChange({
          sessionId: ctx.sessionId,
          turn: ctx.turn || 1,
          tool: "write_file",
          relPath: p,
          beforeContent: previous,
          afterContent: content,
          workspace: ctx.workspace,
        }).catch(() => {});
      }
      const lines = content ? content.replace(/\n$/, "").split("\n").length : 0;
      if (previous === null) return `Created ${p} (${lines} lines, ${content.length} bytes)`;
      const diff = changeSummary(previous, content);
      const head = `Overwrote ${p} (${lines} lines, ${content.length} bytes)`;
      return diff ? `${head}\n${diff}` : `${head}\n[content was already identical]`;
    },
  },

  edit_file: {
    spec: {
      name: "edit_file",
      description:
        "Replace an exact string in a file. old_string must appear exactly once unless replace_all is true. Include surrounding context to make it unique.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          old_string: { type: "string" },
          new_string: { type: "string" },
          replace_all: { type: "boolean" },
        },
        required: ["path", "old_string", "new_string"],
      },
    },
    async run({ path: p, old_string, new_string, replace_all = false }, ctx) {
      const abs = resolveInside(ctx, p);
      if (old_string === new_string) throw new ToolError("old_string and new_string are identical");
      const text = await fsp.readFile(abs, "utf8").catch(() => {
        throw new ToolError(`no such file: ${p}`);
      });
      const count = text.split(old_string).length - 1;
      if (count === 0) throw new ToolError(`old_string not found in ${p}`);
      if (count > 1 && !replace_all) {
        throw new ToolError(
          `old_string appears ${count} times in ${p}; add context to make it unique or pass replace_all`,
        );
      }
      const next = replace_all ? text.split(old_string).join(new_string) : text.replace(old_string, new_string);
      await fsp.writeFile(abs, next, "utf8");
      if (ctx.sessionId) {
        await recordFileChange({
          sessionId: ctx.sessionId,
          turn: ctx.turn || 1,
          tool: "edit_file",
          relPath: p,
          beforeContent: text,
          afterContent: next,
          workspace: ctx.workspace,
        }).catch(() => {});
      }
      const n = replace_all ? count : 1;
      const head = `Edited ${p} (${n} replacement${n > 1 ? "s" : ""})`;
      const diff = changeSummary(text, next);
      return diff ? `${head}\n${diff}` : head;
    },
  },

  list_dir: {
    spec: {
      name: "list_dir",
      description: "List the entries of a directory. Directories are marked with a trailing slash.",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "Defaults to the workspace root." } },
      },
    },
    async run({ path: p = "." }, ctx) {
      const abs = resolveInside(ctx, p);
      const entries = await fsp.readdir(abs, { withFileTypes: true }).catch(() => {
        throw new ToolError(`cannot list ${p}`);
      });
      if (!entries.length) return `${p} is empty`;
      const out = entries
        .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
        .sort((a, b) => Number(b.endsWith("/")) - Number(a.endsWith("/")) || a.localeCompare(b));
      return clip(out.join("\n"));
    },
  },

  glob: {
    spec: {
      name: "glob",
      description:
        "Find files by glob pattern, e.g. src/**/*.js. Skips .git, node_modules and other build dirs. Results are newest-first.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string" },
          path: { type: "string", description: "Directory to search from, defaults to workspace root." },
        },
        required: ["pattern"],
      },
    },
    async run({ pattern, path: p = "." }, ctx) {
      const root = resolveInside(ctx, p);

      // fd when the device has it, the JavaScript walk when it does not. Both
      // must produce the same file set; only the speed differs.
      let rels = null;
      const fast = await rgGlob({
        root,
        pattern,
        limit: GLOB_LIMIT,
        ignoreDirs: IGNORE_DIRS,
        signal: ctx.signal,
      });
      if (fast.ok) rels = fast.files;

      if (rels === null) {
        const re = globToRegExp(pattern);
        rels = [];
        await walk(root, (rel) => {
          if (re.test(rel)) rels.push(rel);
        });
      }

      if (!rels.length) return `no files match ${pattern}`;
      // Newest first: what the agent wants is usually what changed last.
      const hits = rels.map((rel) => {
        const stat = fs.statSync(path.join(root, rel), { throwIfNoEntry: false });
        return { rel, mtime: stat?.mtimeMs ?? 0 };
      });
      hits.sort((a, b) => b.mtime - a.mtime || (a.rel < b.rel ? -1 : 1));
      return clip(hits.slice(0, 500).map((h) => h.rel).join("\n"));
    },
  },

  grep: {
    spec: {
      name: "grep",
      description:
        "Search file contents with a regular expression. Returns path:line:text for each match, sorted by path.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string" },
          include: { type: "string", description: "Glob filter on the file path, e.g. *.ts" },
          path: { type: "string" },
          max_results: { type: "integer" },
        },
        required: ["pattern"],
      },
    },
    async run({ pattern, include, path: p = ".", max_results = 200 }, ctx) {
      const root = resolveInside(ctx, p);
      if (typeof pattern !== "string" || !pattern.length) throw new ToolError("pattern is required");

      // ripgrep is many times faster on a phone, so prefer it - but only when it
      // can be trusted to answer identically. See src/fastsearch.js.
      const fast = await rgSearch({
        root,
        pattern,
        include,
        maxResults: MAX_GREP_LINES,
        maxFileSize: MAX_FILE,
        ignoreDirs: IGNORE_DIRS,
        signal: ctx.signal,
      });
      if (fast.ok) return formatGrep(fast.lines, pattern, max_results);

      let re;
      try {
        re = new RegExp(pattern);
      } catch (err) {
        throw new ToolError(`invalid regex: ${/** @type {Error} */ (err).message}`);
      }
      const includeRe = include ? globToRegExp(include) : null;
      // "*.ts" is meant as a filename filter, "src/**/*.ts" as a path filter.
      const matchBasename = Boolean(include) && !include.includes("/");
      /** @type {string[]} */
      const files = [];
      await walk(root, (rel) => {
        if (includeRe) {
          const target = matchBasename ? rel.slice(rel.lastIndexOf("/") + 1) : rel;
          if (!includeRe.test(target)) return;
        }
        files.push(rel);
      });

      /** @type {string[]} */
      const out = [];
      for (const rel of files) {
        if (out.length >= MAX_GREP_LINES) break;
        const abs = path.join(root, rel);
        const stat = fs.statSync(abs, { throwIfNoEntry: false });
        if (!stat || stat.size > MAX_FILE) continue;
        let text;
        try {
          text = await fsp.readFile(abs, "utf8");
        } catch {
          continue;
        }
        if (text.includes("\u0000")) continue; // binary
        const lines = text.split("\n");
        for (let i = 0; i < lines.length && out.length < MAX_GREP_LINES; i++) {
          if (re.test(lines[i])) out.push(`${rel}:${i + 1}: ${lines[i].slice(0, 400)}`);
        }
      }
      return formatGrep(out, pattern, max_results);
    },
  },

  run_command: {
    spec: {
      name: "run_command",
      description:
        "Run a shell command in the workspace. Use for git, tests, builds, package managers. Not for reading or editing files - the dedicated tools are better. Long output is truncated.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string" },
          cwd: { type: "string", description: "Relative to the workspace root." },
          timeout_ms: { type: "integer", description: `Default ${DEFAULT_TIMEOUT}.` },
        },
        required: ["command"],
      },
    },
    async run({ command, cwd = ".", timeout_ms = DEFAULT_TIMEOUT }, ctx) {
      if (typeof command !== "string" || !command.trim()) throw new ToolError("command is required");
      const dir = resolveInside(ctx, cwd);

      const deny = [...HARD_DENY, ...(ctx.denyCommands || []).map((s) => new RegExp(s))];
      for (const re of deny) {
        if (re.test(command)) throw new ToolError(`blocked by safety rule ${re}: ${command}`);
      }

      if (!ctx.autoApproveCommands || ctx.mode === "plan") {
        const reason = WRITES_OUTSIDE.test(command)
          ? "installs or removes packages outside the workspace"
          : ctx.mode === "plan"
            ? "runs a shell command, and plan mode never auto-approves one"
            : "runs a shell command";
        const ok = await ctx.approve({ kind: "command", command, cwd: dir, reason });
        if (!ok) throw new ToolError("the user denied this command");
      }

      return await exec(command, dir, timeout_ms, ctx.signal);
    },
  },

  tree: {
    spec: {
      name: "tree",
      description: "Show a recursive directory tree. Skips .git, node_modules and other build dirs. Depth defaults to 3.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Directory to start from. Defaults to workspace root." },
          depth: { type: "integer", description: "Max depth. Default 3." },
        },
      },
    },
    async run({ path: p = ".", depth = 3 }, ctx) {
      const root = resolveInside(ctx, p);
      const lines = [];
      async function descend(dir, prefix, d) {
        if (d < 0) return;
        let entries;
        try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
        entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
        for (let i = 0; i < entries.length; i++) {
          const e = entries[i];
          const last = i === entries.length - 1;
          const branch = last ? "└── " : "├── ";
          const childPrefix = prefix + (last ? "    " : "│   ");
          lines.push(prefix + branch + e.name + (e.isDirectory() ? "/" : ""));
          if (e.isDirectory() && !IGNORE_DIRS.has(e.name)) {
            await descend(path.join(dir, e.name), childPrefix, d - 1);
          }
        }
      }
      lines.push(path.basename(root) + "/");
      await descend(root, "", depth - 1);
      if (!lines.length) return `${p} is empty`;
      return clip(lines.join("\n"));
    },
  },

  move_file: {
    spec: {
      name: "move_file",
      description: "Move or rename a file or directory within the workspace.",
      parameters: {
        type: "object",
        properties: {
          src: { type: "string", description: "Source path relative to workspace root." },
          dst: { type: "string", description: "Destination path relative to workspace root." },
        },
        required: ["src", "dst"],
      },
    },
    async run({ src, dst }, ctx) {
      const absSrc = resolveInside(ctx, src);
      const absDst = resolveInside(ctx, dst);
      await fsp.mkdir(path.dirname(absDst), { recursive: true });
      await fsp.rename(absSrc, absDst);
      return `Moved ${src} → ${dst}`;
    },
  },

  delete_file: {
    spec: {
      name: "delete_file",
      description: "Delete a file from the workspace. Use with caution — this is permanent.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
        },
        required: ["path"],
      },
    },
    async run({ path: p }, ctx) {
      const abs = resolveInside(ctx, p);
      const stat = await fsp.stat(abs).catch(() => null);
      if (!stat) throw new ToolError(`no such file: ${p}`);
      if (stat.isDirectory()) throw new ToolError(`${p} is a directory; use run_command rm -rf for directories`);
      await fsp.unlink(abs);
      return `Deleted ${p}`;
    },
  },

  patch_file: {
    spec: {
      name: "patch_file",
      description:
        "Apply a unified diff (--- / +++ / @@ format) to a file. Every context and removed line must match the file, so a stale diff is rejected instead of corrupting the file. Prefer edit_file for a single small change.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          diff: { type: "string", description: "Unified diff. Hunks start with @@ -old,+new @@." },
        },
        required: ["path", "diff"],
      },
    },
    async run({ path: p, diff }, ctx) {
      const abs = resolveInside(ctx, p);
      const original = await fsp.readFile(abs, "utf8").catch(() => {
        throw new ToolError(`no such file: ${p}`);
      });
      const { text, applied, shifted } = applyUnifiedDiff(original, String(diff));
      await fsp.writeFile(abs, text, "utf8");
      if (ctx.sessionId) {
        await recordFileChange({
          sessionId: ctx.sessionId,
          turn: ctx.turn || 1,
          tool: "patch_file",
          relPath: p,
          beforeContent: original,
          afterContent: text,
          workspace: ctx.workspace,
        }).catch(() => {});
      }
      const note = shifted ? ` (${shifted} hunk(s) matched at a shifted line number)` : "";
      const summary = changeSummary(original, text);
      const head = `Applied ${applied} hunk(s) to ${p}${note}`;
      return summary ? `${head}\n${summary}` : head;
    },
  },

  web_search: {
    spec: {
      name: "web_search",
      description:
        "Search the web and get back titles, URLs and snippets. Use it when you need something you do not know: a library's current API, an error message, a version-specific behaviour. Follow up with read_url on the most promising result - the snippets alone are rarely enough to write code from.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
          limit: { type: "integer", description: "How many results, default 8, max 15." },
        },
        required: ["query"],
      },
    },
    async run({ query, limit = 8 }, ctx) {
      if (typeof query !== "string" || !query.trim()) throw new ToolError("query is required");
      const n = Math.min(Math.max(Number(limit) || 8, 1), 15);
      const res = await webSearch({ query, limit: n, signal: ctx.signal });
      if (!res.ok) throw new ToolError(/** @type {{reason: string}} */ (res).reason);
      if (!res.results.length) return `no results for ${query}`;
      return clip(
        res.results
          .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}${r.snippet ? `\n   ${r.snippet}` : ""}`)
          .join("\n\n"),
      );
    },
  },

  todo_write: {
    spec: {
      name: "todo_write",
      description:
        "Record or update your plan for the current task as a checklist. Pass the WHOLE list every time, not just the changed item. Use it for anything that takes more than a couple of steps: write the plan first, then mark each item in_progress before you start it and done the moment it is finished. Exactly one item should be in_progress at a time.",
      parameters: {
        type: "object",
        properties: {
          items: {
            type: "array",
            description: "The complete checklist, in order.",
            items: {
              type: "object",
              properties: {
                text: { type: "string", description: "Short, specific, actionable." },
                status: { type: "string", enum: ["pending", "in_progress", "done"] },
              },
              required: ["text", "status"],
            },
          },
        },
        required: ["items"],
      },
    },
    async run({ items }, ctx) {
      if (!ctx.sessionId) throw new ToolError("todo_write is not available here");
      if (!Array.isArray(items)) throw new ToolError("items must be an array");
      if (items.length > 60) throw new ToolError("that is too many items; keep the plan to the current task");

      const STATUSES = new Set(["pending", "in_progress", "done"]);
      const clean = items.map((raw, i) => {
        const text = String(raw?.text ?? "").replace(/\s+/g, " ").trim();
        if (!text) throw new ToolError(`item ${i + 1} has no text`);
        const status = String(raw?.status ?? "pending");
        if (!STATUSES.has(status)) {
          throw new ToolError(`item ${i + 1} has status "${status}"; use pending, in_progress or done`);
        }
        return { text: text.slice(0, 200), status: /** @type {any} */ (status) };
      });

      // More than one in_progress is the failure mode that makes a plan useless:
      // it stops meaning "what I am doing now".
      const running = clean.filter((c) => c.status === "in_progress");
      if (running.length > 1) {
        throw new ToolError(
          `${running.length} items are in_progress; exactly one should be, so the list still says what you are doing now`,
        );
      }

      writeTodos(ctx.sessionId, clean);
      if (ctx.onTodo) ctx.onTodo(clean);

      const done = clean.filter((c) => c.status === "done").length;
      const glyph = { done: "x", in_progress: ">", pending: " " };
      const body = clean.map((c) => `[${glyph[c.status]}] ${c.text}`).join("\n");
      return `Plan (${done}/${clean.length} done):\n${body}`;
    },
  },

  read_url: {    spec: {
      name: "read_url",
      description: "Fetch the text content of a URL (documentation, README, API reference). Returns plain text, HTML stripped.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string" },
          max_chars: { type: "integer", description: "Truncate response to this many chars. Default 8000." },
        },
        required: ["url"],
      },
    },
    async run({ url, max_chars = 8000 }, ctx) {
      let parsed;
      try { parsed = new URL(url); } catch { throw new ToolError(`invalid URL: ${url}`); }
      if (!['http:', 'https:'].includes(parsed.protocol)) throw new ToolError(`only http/https allowed`);
      const res = await fetch(url, { signal: ctx.signal, headers: { 'User-Agent': 'tca-agent/1.0' } }).catch(e => { throw new ToolError(`fetch failed: ${e.message}`); });
      if (!res.ok) throw new ToolError(`HTTP ${res.status} from ${url}`);
      const ct = res.headers.get('content-type') || '';
      const text = await res.text();
      // Strip HTML tags for readability
      const plain = ct.includes('html') ? text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '').replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<[^>]+>/g, '').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'\"').replace(/&#039;/g,"'").replace(/[ \t]{2,}/g,' ').replace(/\n{3,}/g,'\n\n').trim() : text;
      return clip(plain, max_chars);
    },
  },

  batch_read: {
    spec: {
      name: "batch_read",
      description: "Read multiple files in one call. Returns each file's content separated by a header. More efficient than multiple read_file calls.",
      parameters: {
        type: "object",
        properties: {
          paths: { type: "array", items: { type: "string" }, description: "Array of paths relative to workspace root." },
          limit_per_file: { type: "integer", description: "Max lines per file. Default 200." },
        },
        required: ["paths"],
      },
    },
    async run({ paths, limit_per_file = 200 }, ctx) {
      if (!Array.isArray(paths) || !paths.length) throw new ToolError('paths must be a non-empty array');
      if (paths.length > 20) throw new ToolError('max 20 files per batch_read call');
      const parts = [];
      await Promise.all(paths.map(async (p) => {
        const abs = resolveInside(ctx, p);
        const stat = await fsp.stat(abs).catch(() => null);
        if (!stat || stat.isDirectory()) { parts.push({ p, text: '[not found or is directory]' }); return; }
        if (stat.size > MAX_FILE) { parts.push({ p, text: '[file too large]' }); return; }
        const text = await fsp.readFile(abs, 'utf8').catch(() => '[read error]');
        const lines = text.split('\n').slice(0, limit_per_file);
        const truncated = text.split('\n').length > limit_per_file ? `\n[... truncated at ${limit_per_file} lines]` : '';
        parts.push({ p, text: lines.join('\n') + truncated });
      }));
      // Sort back to requested order
      parts.sort((a, b) => paths.indexOf(a.p) - paths.indexOf(b.p));
      return clip(parts.map(({ p, text }) => `=== ${p} ===\n${text}`).join('\n\n'));
    },
  },

  task: {
    spec: {
      name: "task",
      description:
        "Delegate a self-contained piece of work to a sub-agent and get back only its final answer. " +
        "Use this for anything that needs to read a lot to produce a little: locating where a feature lives, " +
        "auditing every call site of a function, working out how a subsystem fits together. " +
        "The sub-agent has its own fresh context and its own tool budget, so twenty file reads cost you one " +
        "summary instead of twenty file dumps - this is the main way to keep a long task from filling the " +
        "context window. It cannot ask you questions and it shares your workspace, so state the goal completely " +
        "and say exactly what you want back.",
      parameters: {
        type: "object",
        properties: {
          description: { type: "string", description: "Three to five words, shown in the UI." },
          prompt: {
            type: "string",
            description:
              "The full task. Include the context the sub-agent needs, what to investigate or do, and the exact shape of the answer you expect back.",
          },
          kind: {
            type: "string",
            enum: ["explore", "general"],
            description:
              "explore: read-only investigation, cannot write or run commands - use this by default. general: full tool access, for work that has to change files.",
          },
        },
        required: ["description", "prompt"],
      },
    },
    async run({ description, prompt, kind = "explore" }, ctx) {
      if (!ctx.spawnAgent) throw new ToolError("sub-agents are not available here");
      if (typeof prompt !== "string" || prompt.trim().length < 10) {
        throw new ToolError("prompt must be a complete task description; the sub-agent cannot ask you for more");
      }
      if (kind !== "explore" && kind !== "general") throw new ToolError(`unknown kind: ${kind}`);
      if (ctx.mode === "plan" && kind === "general") {
        throw new ToolError("plan mode is read-only, so a general sub-agent cannot run here; use kind: explore");
      }
      const answer = await ctx.spawnAgent({ prompt: String(prompt), kind });
      return clip(answer || "[the sub-agent returned nothing]");
    },
  },

  verify: {
    spec: {
      name: "verify",
      description:
        "Run the project's own checker over the given files and report what it says. Files are checked with " +
        "whatever the project already has: node --check, tsc --noEmit, ruff, gofmt, bash -n, a JSON parse. " +
        "Writes already run this automatically; call it directly when you want to confirm the current state " +
        "without changing anything.",
      parameters: {
        type: "object",
        properties: {
          paths: { type: "array", items: { type: "string" }, description: "Workspace-relative files to check." },
        },
        required: ["paths"],
      },
    },
    async run({ paths }, ctx) {
      if (!Array.isArray(paths) || !paths.length) throw new ToolError("paths must be a non-empty array");
      const rels = paths.slice(0, 30).map((p) => {
        resolveInside(ctx, String(p)); // confinement check, throws if outside
        return String(p);
      });
      const found = await diagnose({ workspace: ctx.workspace, files: rels, signal: ctx.signal });
      if (!found.length) return "No checker is available for these file types on this device.";
      const body = formatDiagnoses(found).replace(/^\n+--- checked after this change ---\n/, "");
      return clip(body);
    },
  },
};

/**
 * @param {string} command
 * @param {string} cwd
 * @param {number} timeout
 * @param {AbortSignal} [signal]
 */
async function exec(command, cwd, timeout, signal) {
  const r = await execRun({ command, cwd, timeout, maxOutput: MAX_OUTPUT * 2, signal });
  if (r.spawnError) throw new ToolError(`failed to start command: ${r.spawnError}`);
  const body = clip(r.output || "[no output]");
  const note = r.truncated ? "\n[output truncated]" : "";
  if (r.timedOut) throw new ToolError(`timed out after ${timeout}ms\n${body}${note}`);
  if (r.code === 0) return `${body}${note}`;
  throw new ToolError(`exit ${r.code ?? r.signal}\n${body}${note}`);
}

/**
 * Tools that change the filesystem. Gated by autoApproveEdits, and gated in one
 * place rather than five so a new write tool cannot forget to ask.
 * @type {Record<string, (input: any) => {what: string, reason: string}>}
 */
const EDIT_TOOLS = {
  write_file: (i) => ({
    what: `write_file  ${i?.path}`,
    reason: "creates the file, or replaces its entire contents",
  }),
  edit_file: (i) => ({
    what: `edit_file  ${i?.path}`,
    reason: i?.replace_all ? "replaces every occurrence of a string" : "replaces a string in the file",
  }),
  patch_file: (i) => ({ what: `patch_file  ${i?.path}`, reason: "applies a diff to the file" }),
  move_file: (i) => ({ what: `move_file  ${i?.src} -> ${i?.dst}`, reason: "moves or renames it" }),
  delete_file: (i) => ({ what: `delete_file  ${i?.path}`, reason: "deletes the file permanently" }),
};

/** Read-only tools. The complement of this is what plan mode and explore agents lose. */
const READ_ONLY = new Set([
  "read_file",
  "batch_read",
  "list_dir",
  "tree",
  "glob",
  "grep",
  "read_url",
  "web_search",
  "verify",
  "todo_write",
]);

/**
 * Which tools exist for a given agent.
 *
 * Three shapes rather than one, because "what may this agent do" is a safety
 * property and the cheapest way to enforce it is to never mention the tool:
 *
 *   build    everything - the normal agent
 *   plan     read-only. run_command survives because inspecting a repo needs git
 *            log and git diff, but it can never be auto-approved in this mode.
 *   explore  read-only and no sub-agents, so a delegated investigation cannot
 *            recurse or quietly start writing files.
 *
 * @param {{mode?: "build"|"plan", kind?: "root"|"explore"|"general"}} [opts]
 * @returns {import("./provider.js").ToolSpec[]}
 */
export function toolSpecs(opts = {}) {
  const { mode = "build", kind = "root" } = opts;
  const readOnly = mode === "plan" || kind === "explore";
  return Object.entries(TOOLS)
    .filter(([name]) => {
      // Only the top-level agent delegates. Letting sub-agents spawn sub-agents
      // is how one tap turns into an unbounded fan-out of paid API calls.
      if (name === "task") return kind === "root";
      // Plan mode keeps `task` above, because investigating a codebase is exactly
      // what plan mode is for and an explore sub-agent is read-only anyway. The
      // tool itself refuses a writing sub-agent in this mode.
      if (readOnly && !READ_ONLY.has(name) && name !== "run_command") return false;
      return true;
    })
    .map(([, t]) => t.spec);
}

/** Files a tool call is about to change, for the post-write check. */
function touchedPaths(name, input) {
  if (name === "write_file" || name === "edit_file" || name === "patch_file") {
    return input?.path ? [String(input.path)] : [];
  }
  if (name === "move_file") return input?.dst ? [String(input.dst)] : [];
  return [];
}

/**
 * Execute one tool call.
 * @param {string} name
 * @param {any} input
 * @param {ToolContext} ctx
 * @returns {Promise<{ok: boolean, output: string}>}
 */
export async function callTool(name, input, ctx) {
  const tool = TOOLS[name];
  if (!tool) return { ok: false, output: `unknown tool: ${name}` };
  if (input?.__parse_error) {
    return { ok: false, output: `could not parse your arguments as JSON: ${input.__raw?.slice(0, 200)}` };
  }
  try {
    // Belt and braces: plan mode already withholds these specs, but a model that
    // remembers a tool from earlier in the conversation must not be able to use it.
    if (ctx.mode === "plan" && EDIT_TOOLS[name]) {
      throw new ToolError(
        `plan mode is read-only, so ${name} is not available. Describe the change you would make; ` +
          "the user switches to build mode when they want it applied.",
      );
    }
    // Explicit false only: a ToolContext built without the flag (older configs,
    // direct callers) keeps the previous behaviour of not asking.
    if (ctx.autoApproveEdits === false && EDIT_TOOLS[name]) {
      const { what, reason } = EDIT_TOOLS[name](input || {});
      const ok = await ctx.approve({ kind: "edit", command: what, cwd: ctx.workspace, reason });
      if (!ok) throw new ToolError("the user denied this file change");
    }

    let output = await tool.run(input || {}, ctx);

    // Check what we just wrote. Appended to the tool result rather than emitted
    // separately so the model cannot miss it: it arrives attached to the edit it
    // is about, in the same message, whatever the model does next.
    if (ctx.verifyEdits !== false) {
      const files = touchedPaths(name, input);
      if (files.length) {
        const found = await diagnose({ workspace: ctx.workspace, files, signal: ctx.signal });
        output += formatDiagnoses(found.filter((d) => !d.ok || found.length === 1));
      }
    }
    return { ok: true, output };
  } catch (err) {
    const e = /** @type {Error} */ (err);
    // Tool failures are normal control flow: hand the message back so the model
    // can correct itself rather than aborting the turn.
    return { ok: false, output: e instanceof ToolError ? e.message : `${e.name}: ${e.message}` };
  }
}
