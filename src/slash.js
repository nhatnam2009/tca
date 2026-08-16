/**
 * Slash commands and custom agents engine.
 *
 * Provides built-in slash shortcuts (/help, /undo, /redo, /review, /test, /commit)
 * and custom agent resolution from config.customAgents.
 */

export const BUILTIN_COMMANDS = [
  {
    name: "help",
    description: "Show available slash commands and descriptions",
    kind: "builtin",
  },
  {
    name: "undo",
    description: "Revert file changes from the last turn",
    kind: "builtin",
  },
  {
    name: "redo",
    description: "Reapply previously undone file changes",
    kind: "builtin",
  },
  {
    name: "review",
    description: "Review recent changes for bugs, style, and security issues",
    kind: "builtin",
    systemPrompt:
      "You are an expert code reviewer. Read the code and git diff carefully, identify bugs, security concerns, performance issues, and suggest concrete improvements with severity ratings.",
    mode: "plan",
  },
  {
    name: "test",
    description: "Generate comprehensive unit tests for code in workspace",
    kind: "builtin",
    systemPrompt:
      "You are an expert test engineer. Write clean, robust unit tests with full coverage using the project's native test runner (node:test, pytest, jest, etc.).",
    mode: "build",
  },
  {
    name: "commit",
    description: "Inspect git diff and generate a clear, conventional git commit message",
    kind: "builtin",
    systemPrompt:
      "Inspect the current git status and diff. Summarize what changed and why, using conventional commit format (feat, fix, refactor, test, docs). Propose the commit command.",
    mode: "build",
  },
];

/**
 * Parse input text to see if it starts with a slash command.
 * @param {string} text
 * @returns {{ isSlash: boolean, name?: string, args?: string, raw: string }}
 */
export function parseSlashCommand(text) {
  if (typeof text !== "string") return { isSlash: false, raw: "" };
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return { isSlash: false, raw: text };

  const match = /^\/([a-zA-Z0-9_-]+)(?:\s+([\s\S]*))?$/.exec(trimmed);
  if (!match) return { isSlash: false, raw: text };

  return {
    isSlash: true,
    name: match[1].toLowerCase(),
    args: match[2] ? match[2].trim() : "",
    raw: text,
  };
}

/**
 * List all available slash commands including custom agents from config.
 * @param {import("./config.js").Config} [config]
 * @returns {Array<{ name: string, description: string, kind: "builtin"|"custom", agent?: any }>}
 */
export function listSlashCommands(config) {
  const list = [...BUILTIN_COMMANDS];
  const custom = config?.customAgents || {};
  for (const [name, agent] of Object.entries(custom)) {
    list.push({
      name: name.toLowerCase(),
      description: agent.description || agent.name || `Custom agent: ${name}`,
      kind: "custom",
      agent,
    });
  }
  return list;
}

/**
 * Find matching slash command definition.
 * @param {string} name
 * @param {import("./config.js").Config} [config]
 */
export function findSlashCommand(name, config) {
  const lower = name.toLowerCase();
  const builtIn = BUILTIN_COMMANDS.find((c) => c.name === lower);
  if (builtIn) return builtIn;

  const custom = config?.customAgents?.[lower] || config?.customAgents?.[name];
  if (custom) {
    return {
      name: lower,
      description: custom.description || custom.name || `Custom agent: ${name}`,
      kind: "custom",
      systemPrompt: custom.systemPrompt || custom.prompt,
      mode: custom.mode || "build",
      tools: custom.tools,
      model: custom.model,
      agent: custom,
    };
  }
  return null;
}

/**
 * Resolve user prompt and potential slash command overrides for agent turn.
 * @param {string} text
 * @param {import("./config.js").Config} config
 * @returns {{ prompt: string, extraInstructions?: string, mode?: "build"|"plan", model?: string, handledLocally?: boolean, localAction?: string }}
 */
export function resolveSlashPrompt(text, config) {
  const parsed = parseSlashCommand(text);
  if (!parsed.isSlash) return { prompt: text };

  const cmd = findSlashCommand(parsed.name, config);
  if (!cmd) return { prompt: text };

  if (cmd.name === "help") {
    const list = listSlashCommands(config);
    const body = list.map((c) => `/${c.name} - ${c.description} (${c.kind})`).join("\n");
    return {
      prompt: text,
      handledLocally: true,
      localAction: "help",
      localResult: `Available slash commands:\n${body}`,
    };
  }

  if (cmd.name === "undo" || cmd.name === "redo") {
    return {
      prompt: text,
      handledLocally: true,
      localAction: cmd.name,
    };
  }

  const userArgs = parsed.args || "";
  let prompt = userArgs;
  if (!prompt) {
    if (cmd.name === "review") prompt = "Please review recent code changes and git diff in the workspace.";
    else if (cmd.name === "test") prompt = "Please write tests for the recently modified code in the workspace.";
    else if (cmd.name === "commit") prompt = "Please check git diff and craft a conventional commit message.";
    else prompt = `Execute task for custom agent ${cmd.name}.`;
  }

  return {
    prompt,
    extraInstructions: cmd.systemPrompt,
    mode: cmd.mode,
    model: cmd.model,
  };
}
