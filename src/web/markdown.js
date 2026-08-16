/**
 * Zero-dependency markdown renderer & syntax highlighter.
 *
 * Rules:
 *   - all text reaches DOM via textContent / Text nodes, never innerHTML;
 *   - code blocks include copy button and line highlighting;
 *   - unified diff hunks get color-coded per line;
 *   - safe against malformed input and infinite loops.
 */

import { el, t } from "./helpers.js";

/** Split raw text into fenced-code and prose segments. */
export function splitFences(src) {
  const out = [];
  let plain = [];
  let fence = null;
  const flushPlain = () => {
    const text = plain.join("\n").replace(/^\n+|\n+$/g, "");
    plain = [];
    if (text) out.push({ type: "text", text });
  };
  const closeFence = () => {
    out.push({ type: "code", lang: fence.lang, text: fence.lines.join("\n") });
    fence = null;
  };
  for (const line of String(src).split("\n")) {
    if (fence) {
      const close = line.match(/^ {0,3}(`{3,})[\t]*$/);
      if (close && close[1].length >= fence.ticks) closeFence();
      else fence.lines.push(line);
      continue;
    }
    const open = line.match(/^ {0,3}(`{3,})[\t]*([^`]*?)[\t]*$/);
    if (open) {
      flushPlain();
      fence = { ticks: open[1].length, lang: open[2] || "", lines: [] };
    } else plain.push(line);
  }
  if (fence) closeFence();
  else flushPlain();
  return out;
}

/**
 * Render one line of inline markdown into a DocumentFragment.
 * Handles: **bold**, *italic*, `code`, [link](url)
 * All text is set via textContent — no innerHTML.
 */
export function renderInline(text) {
  const frag = document.createDocumentFragment();
  const re = /`([^`]+)`|\*\*(.+?)\*\*|~~(.+?)~~|\*(.+?)\*|\[([^\]]+)\]\(([^)]+)\)/g;
  let last = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
    if (m[1] != null) {
      const c = document.createElement("code");
      c.className = "inline-code";
      c.textContent = m[1];
      frag.appendChild(c);
    } else if (m[2] != null) {
      const b = document.createElement("strong");
      b.textContent = m[2];
      frag.appendChild(b);
    } else if (m[3] != null) {
      const s = document.createElement("s");
      s.textContent = m[3];
      frag.appendChild(s);
    } else if (m[4] != null) {
      const i = document.createElement("em");
      i.textContent = m[4];
      frag.appendChild(i);
    } else if (m[5] != null) {
      const span = document.createElement("span");
      span.className = "md-link";
      const tNode = document.createElement("span");
      tNode.textContent = m[5];
      const u = document.createElement("span");
      u.className = "md-link-url";
      u.textContent = ` (${m[6]})`;
      span.append(tNode, u);
      frag.appendChild(span);
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
  return frag;
}

/* ------------------------------------------------- markdown block detection */

export const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;

export function isTableSeparator(line) {
  const s = (line || "").trim();
  return s.includes("-") && /^[|\s:-]+$/.test(s);
}

export function startsTable(lines, i) {
  return lines[i].includes("|") && i + 1 < lines.length && isTableSeparator(lines[i + 1]);
}

export function tableCells(line) {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  return s.split("|").map((c) => c.trim());
}

export function startsBlock(lines, i) {
  const line = lines[i];
  return (
    !line.trim() ||
    /^#{1,3}\s/.test(line) ||
    LIST_ITEM.test(line) ||
    line === ">" ||
    line.startsWith("> ") ||
    /^(-{3,}|\*{3,}|_{3,})$/.test(line.trim()) ||
    startsTable(lines, i)
  );
}

export function collectListItems(lines, start) {
  const items = [];
  let i = start;
  while (i < lines.length) {
    const m = LIST_ITEM.exec(lines[i]);
    if (m) {
      items.push({
        indent: m[1].replace(/\t/g, "  ").length,
        ordered: /\d/.test(m[2]),
        text: m[3],
      });
      i++;
      continue;
    }
    if (items.length && lines[i].trim() && /^\s{2,}\S/.test(lines[i])) {
      items[items.length - 1].text += ` ${lines[i].trim()}`;
      i++;
      continue;
    }
    break;
  }
  return { items, next: i };
}

export function listItemContent(text) {
  const task = /^\[([ xX])\]\s+(.*)$/.exec(text);
  if (!task) return renderInline(text);
  const frag = document.createDocumentFragment();
  const box = el("span", "md-task", task[1] === " " ? "\u2610" : "\u2611");
  frag.append(box, document.createTextNode(" "), renderInline(task[2]));
  return frag;
}

export function buildList(items, from, indent) {
  const ordered = items[from].ordered;
  const list = el(ordered ? "ol" : "ul", "md-list");
  let k = from;
  while (k < items.length && items[k].indent >= indent) {
    if (items[k].indent > indent) {
      const nested = buildList(items, k, items[k].indent);
      (list.lastElementChild || list).appendChild(nested.node);
      k = nested.next;
      continue;
    }
    if (items[k].ordered !== ordered) break;
    const li = document.createElement("li");
    if (items[k].text.startsWith("[")) li.className = "md-task-item";
    li.appendChild(listItemContent(items[k].text));
    list.appendChild(li);
    k++;
  }
  return { node: list, next: k };
}

/** Parse a group of prose lines into block-level elements. */
export function renderProseLines(lines) {
  const frag = document.createDocumentFragment();
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) { i++; continue; }

    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      const tag = `h${heading[1].length + 2}`;
      const h = document.createElement(tag);
      h.className = "md-heading";
      h.appendChild(renderInline(heading[2]));
      frag.appendChild(h);
      i++; continue;
    }

    if (/^-{3,}$|^\*{3,}$|^_{3,}$/.test(line.trim())) {
      frag.appendChild(document.createElement("hr"));
      i++; continue;
    }

    if (line.startsWith("> ") || line === ">") {
      const bq = document.createElement("blockquote");
      bq.className = "md-blockquote";
      const bqLines = [];
      while (i < lines.length && (lines[i].startsWith("> ") || lines[i] === ">")) {
        bqLines.push(lines[i].replace(/^>\s?/, ""));
        i++;
      }
      const inner = renderProseLines(bqLines);
      bq.appendChild(inner);
      frag.appendChild(bq);
      continue;
    }

    if (startsTable(lines, i)) {
      const table = document.createElement("table");
      table.className = "md-table";
      const thead = document.createElement("thead");
      const tbody = document.createElement("tbody");
      const tr = document.createElement("tr");
      for (const cell of tableCells(line)) {
        const th = document.createElement("th");
        th.appendChild(renderInline(cell));
        tr.appendChild(th);
      }
      thead.appendChild(tr);
      table.appendChild(thead);
      i += 2;
      while (i < lines.length && lines[i].includes("|")) {
        const row = document.createElement("tr");
        for (const cell of tableCells(lines[i])) {
          const td = document.createElement("td");
          td.appendChild(renderInline(cell));
          row.appendChild(td);
        }
        tbody.appendChild(row);
        i++;
      }
      table.appendChild(tbody);
      frag.appendChild(table);
      continue;
    }

    if (LIST_ITEM.test(line)) {
      const { items, next } = collectListItems(lines, i);
      let k = 0;
      while (k < items.length) {
        const built = buildList(items, k, items[k].indent);
        frag.appendChild(built.node);
        k = built.next > k ? built.next : k + 1;
      }
      i = next;
      continue;
    }

    const paraLines = [];
    while (i < lines.length && !startsBlock(lines, i)) {
      paraLines.push(lines[i]);
      i++;
    }
    if (paraLines.length) {
      const p = document.createElement("p");
      p.className = "md-para";
      p.appendChild(renderInline(paraLines.join(" ")));
      frag.appendChild(p);
    } else {
      i++;
    }
  }
  return frag;
}

/* --------------------------------------------------------- syntax highlight */

export const KEYWORDS = {
  c: "as async await break case catch class const continue debugger default delete do else enum export extends finally for from function get if implements import in instanceof interface let new of private protected public readonly return satisfies set static super switch this throw try type typeof var void while with yield",
  py: "and as assert async await break class continue def del elif else except finally for from global if import in is lambda match new nonlocal not or pass raise return try while with yield None True False self",
  go: "break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var nil true false",
  rs: "as async await break const continue crate dyn else enum extern fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait type unsafe use where while",
  sh: "if then else elif fi for while do done case esac in function return exit local export readonly set unset source shift trap",
  sql: "select from where group by order having insert into values update set delete create table drop alter index join left right inner outer on as and or not null limit offset",
};

export const SYNTAX = {
  js: { kw: KEYWORDS.c, line: "//", block: true },
  jsx: { kw: KEYWORDS.c, line: "//", block: true },
  mjs: { kw: KEYWORDS.c, line: "//", block: true },
  cjs: { kw: KEYWORDS.c, line: "//", block: true },
  ts: { kw: KEYWORDS.c, line: "//", block: true },
  tsx: { kw: KEYWORDS.c, line: "//", block: true },
  java: { kw: KEYWORDS.c, line: "//", block: true },
  c: { kw: KEYWORDS.c, line: "//", block: true },
  cpp: { kw: KEYWORDS.c, line: "//", block: true },
  cs: { kw: KEYWORDS.c, line: "//", block: true },
  swift: { kw: KEYWORDS.c, line: "//", block: true },
  kotlin: { kw: KEYWORDS.c, line: "//", block: true },
  css: { kw: "", line: "", block: true },
  json: { kw: "true false null", line: "", block: false },
  py: { kw: KEYWORDS.py, line: "#", block: false },
  python: { kw: KEYWORDS.py, line: "#", block: false },
  go: { kw: KEYWORDS.go, line: "//", block: true },
  rs: { kw: KEYWORDS.rs, line: "//", block: true },
  rust: { kw: KEYWORDS.rs, line: "//", block: true },
  sh: { kw: KEYWORDS.sh, line: "#", block: false },
  bash: { kw: KEYWORDS.sh, line: "#", block: false },
  zsh: { kw: KEYWORDS.sh, line: "#", block: false },
  shell: { kw: KEYWORDS.sh, line: "#", block: false },
  yaml: { kw: "true false null", line: "#", block: false },
  yml: { kw: "true false null", line: "#", block: false },
  toml: { kw: "true false", line: "#", block: false },
  sql: { kw: KEYWORDS.sql, line: "--", block: false },
  html: { kw: "", line: "", block: false, markup: true },
  xml: { kw: "", line: "", block: false, markup: true },
  md: null,
  markdown: null,
  text: null,
  "": null,
};

export function reEscape(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export const grammarCache = new Map();

export function grammarFor(name) {
  if (grammarCache.has(name)) return grammarCache.get(name);
  const cfg = SYNTAX[name];
  let grammar = null;
  if (cfg) {
    const parts = [];
    if (cfg.block) parts.push("(/\\*[\\s\\S]*?(?:\\*/|$))");
    else parts.push("(\\u0000)");
    parts.push(cfg.line ? `(${reEscape(cfg.line)}[^\\n]*)` : "(\\u0000)");
    parts.push("(\"(?:[^\"\\\\\\n]|\\\\.)*\"|'(?:[^'\\\\\\n]|\\\\.)*'|`(?:[^`\\\\]|\\\\.)*`)");
    parts.push("(\\b\\d[\\w.]*\\b)");
    parts.push(cfg.kw ? `\\b(${cfg.kw.trim().split(/\s+/).map(reEscape).join("|")})\\b` : "(\\u0000)");
    parts.push("\\b([A-Za-z_$][\\w$]*)(?=\\s*\\()");
    parts.push(cfg.markup ? "(<[^>\\n]*>)" : "(\\u0000)");
    grammar = new RegExp(parts.join("|"), "g");
  }
  grammarCache.set(name, grammar);
  return grammar;
}

export const TOKEN_CLASS = ["tok-comment", "tok-comment", "tok-str", "tok-num", "tok-kw", "tok-fn", "tok-tag"];

export function highlight(code, lang) {
  const frag = document.createDocumentFragment();
  const name = String(lang || "").toLowerCase().split(/[\s:]/)[0];
  const grammar = grammarFor(name);
  if (!grammar) {
    frag.appendChild(document.createTextNode(code));
    return frag;
  }
  grammar.lastIndex = 0;
  let last = 0;
  let m;
  while ((m = grammar.exec(code)) !== null) {
    if (m[0] === "") {
      grammar.lastIndex++;
      continue;
    }
    if (m.index > last) frag.appendChild(document.createTextNode(code.slice(last, m.index)));
    let cls = "tok-plain";
    for (let g = 1; g <= 7; g++) {
      if (m[g] != null) {
        cls = TOKEN_CLASS[g - 1];
        break;
      }
    }
    frag.appendChild(el("span", cls, m[0]));
    last = m.index + m[0].length;
  }
  if (last < code.length) frag.appendChild(document.createTextNode(code.slice(last)));
  return frag;
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = el("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.className = "offscreen";
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand("copy"); } catch {}
    ta.remove();
    return ok;
  }
}

export function codeBlock(code, lang) {
  const head = el("div", "code-head");
  const btn = el("button", "btn small ghost", t("code.copy"));
  btn.type = "button";
  btn.setAttribute("aria-label", t("code.copyAria"));
  btn.addEventListener("click", async () => {
    const ok = await copyText(code);
    btn.textContent = ok ? t("code.copied") : t("code.copyFailed");
    setTimeout(() => (btn.textContent = t("code.copy")), 1200);
  });
  head.append(el("span", "code-lang", lang || "text"), btn);

  const p = el("pre", "code-pre");
  p.tabIndex = 0;
  const codeEl = el("code");
  codeEl.appendChild(highlight(String(code == null ? "" : code), lang));
  p.appendChild(codeEl);

  const wrap = el("div", "code");
  wrap.append(head, p);
  return wrap;
}

export function pre(text) {
  const p = el("pre");
  p.tabIndex = 0;
  p.appendChild(el("code", null, text == null ? "" : String(text)));
  return p;
}

export function looksLikeDiff(text) {
  return typeof text === "string" && /^@@ -\d+,\d+ \+\d+,\d+ @@/m.test(text);
}

export function diffPre(text) {
  const p = el("pre", "diff");
  p.tabIndex = 0;
  const code = el("code");
  for (const line of String(text).split("\n")) {
    const c = line[0];
    const cls =
      line.startsWith("@@") ? "diff-meta"
      : c === "+" ? "diff-add"
      : c === "-" ? "diff-del"
      : c === "[" ? "diff-meta"
      : "diff-ctx";
    code.appendChild(el("span", cls, `${line}\n`));
  }
  p.appendChild(code);
  return p;
}

export const outputBlock = (text) => (looksLikeDiff(text) ? diffPre(text) : pre(text));

export function renderRich(container, raw) {
  container.textContent = "";
  for (const seg of splitFences(raw)) {
    if (seg.type === "code") {
      container.appendChild(codeBlock(seg.text, seg.lang));
    } else {
      const div = document.createElement("div");
      div.className = "md-prose";
      div.appendChild(renderProseLines(seg.text.split("\n")));
      container.appendChild(div);
    }
  }
}
