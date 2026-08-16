/**
 * tca web UI - single page, two tabs (Chat / Settings).
 *
 * Rules this file follows:
 *   - no dependencies, no build step, nothing fetched from the network but this
 *     daemon (the phone may be offline apart from the LLM API);
 *   - every server- or model-provided string reaches the DOM through
 *     textContent, never innerHTML: tool output and file contents are untrusted;
 *   - phone first - 44px tap targets, Enter is a newline, no hover-only UI.
 */

/* ------------------------------------------------------------------ helpers */

const $ = (id) => document.getElementById(id);

/** Create an element. `text` is always assigned as textContent (never parsed). */
function el(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text != null) n.textContent = text;
  return n;
}

/** <option value=…>label</option> - used by both selects and the datalist. */
function option(value, label) {
  const o = el("option", null, label);
  o.value = value;
  return o;
}

/** localStorage throws in some privacy modes - never let that break the app. */
const store = {
  get: (k) => { try { return localStorage.getItem(k) || ""; } catch { return ""; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
  del: (k) => { try { localStorage.removeItem(k); } catch {} },
};

/* --------------------------------------------------------------------- i18n */

/**
 * Translations come from the server, from the same src/i18n.js that `tca doctor`
 * imports, so the terminal and the UI can never say different things about the
 * same check. This file cannot import it directly (it has to stay loadable as a
 * classic script), so the daemon serves the table as JSON.
 *
 * The English text stays in index.html as written. A `data-i18n` attribute only
 * *overrides* it, which means if this fetch ever fails the UI is still a complete,
 * usable English app instead of a page full of dotted key names.
 */
const LANG_KEY = "tca.lang";
let dict = { vi: {}, en: {} };
let lang = "vi";

async function loadI18n() {
  try {
    const res = await fetch("/assets/i18n.json", { cache: "no-store" });
    if (!res.ok) return;
    const payload = await res.json();
    if (payload && payload.dict) dict = payload.dict;
  } catch {
    // Offline or an old daemon: keep the English already in the HTML.
  }
  const saved = store.get(LANG_KEY);
  lang = normaliseLang(saved || navigator.language || "vi");
}

function normaliseLang(value) {
  const s = String(value || "").toLowerCase();
  for (const l of ["vi", "en"]) if (s.startsWith(l)) return l;
  return "vi";
}

/**
 * Translate. Falls back English, then to the key, so a missing string is visible
 * as a bug rather than as blank space.
 * @param {string} key
 * @param {Record<string, string|number>} [params]
 */
function t(key, params) {
  let s = (dict[lang] && dict[lang][key]) ?? (dict.en && dict.en[key]) ?? key;
  if (params) for (const [k, v] of Object.entries(params)) s = s.split(`{${k}}`).join(String(v));
  return s;
}

/** True when the table actually loaded, i.e. it is safe to replace HTML text. */
const haveDict = () => Boolean(dict[lang] && Object.keys(dict[lang]).length);

/**
 * Fill in every marked element under `root`.
 *   data-i18n       -> textContent
 *   data-i18n-ph    -> placeholder
 *   data-i18n-aria  -> aria-label
 * Safe to call repeatedly; that is how switching language works.
 */
function applyI18n(root = document) {
  if (!haveDict()) return;
  for (const node of root.querySelectorAll("[data-i18n]")) {
    const value = t(node.dataset.i18n);
    if (value !== node.dataset.i18n) node.textContent = value;
  }
  for (const node of root.querySelectorAll("[data-i18n-ph]")) {
    const value = t(node.dataset.i18nPh);
    if (value !== node.dataset.i18nPh) node.setAttribute("placeholder", value);
  }
  for (const node of root.querySelectorAll("[data-i18n-aria]")) {
    const value = t(node.dataset.i18nAria);
    if (value !== node.dataset.i18nAria) node.setAttribute("aria-label", value);
  }
  document.documentElement.lang = lang;
}

/**
 * Switch language. Both tables are already in memory, so this is instant and
 * needs no reload; the whole document is re-labelled and the current view
 * re-rendered so JS-built text follows too.
 */
function setLang(next, { persistToServer = true } = {}) {
  const value = normaliseLang(next);
  if (value === lang) return;
  lang = value;
  store.set(LANG_KEY, value);
  applyI18n(document);
  redrawDynamicText();
  if (persistToServer) {
    api("/api/config", { method: "PUT", body: { ...(serverConfig || {}), lang: value } }).catch(() => {});
    if (serverConfig) serverConfig.lang = value;
  }
}

/** The last /api/config payload, so a language change can be saved without a reload. */
let serverConfig = null;

/**
 * Re-render the parts of the UI that JS wrote rather than HTML: status line,
 * catalog summary, session labels, the Power panel.
 */
function redrawDynamicText() {
  try {
    if (streaming) setStatus(t("chat.working"));
    fillSessionSelect();
    renderCatalogInfo();
    setMode(mode, false);
    renderMeter();
    if (powerData) renderPower(powerData);
  } catch {
    // A redraw is cosmetic; never let it break a language switch.
  }
}

/** An "${ENV_NAME}" apiKey is a pointer, not a secret: never mask it. */
const PLACEHOLDER_KEY = /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/;

/* ------------------------------------------------- catalog value formatting */

/** 2 -> "2", 0.14 -> "0.14", 0 -> "0". Prices are USD per 1M tokens. */
function money(n) {
  return String(Number(Number(n).toFixed(2)));
}

/** 1000000 -> "1M ctx", 262144 -> "262k ctx". */
function fmtContext(ctx) {
  if (!ctx || typeof ctx !== "number") return "";
  if (ctx >= 1_000_000) return `${String(Math.round((ctx / 1_000_000) * 10) / 10)}M ctx`;
  if (ctx >= 1000) return `${Math.round(ctx / 1000)}k ctx`;
  return `${ctx} ctx`;
}

/** "$2/$10 per 1M", or "" when the catalog has no prices. */
function fmtPrice(m) {
  if (!m || m.input_cost == null || m.output_cost == null) return "";
  return `$${money(m.input_cost)}/$${money(m.output_cost)} per 1M`;
}

/** One-line description of a catalog model, for <option> labels. */
function modelLabel(m) {
  return [m.name || m.id, fmtContext(m.context), fmtPrice(m)].filter(Boolean).join(" \u00b7 ");
}

/* ------------------------------------------------ connection-test rendering */

/** Spinner + text while POST /api/providers/test is in flight. */
function testPending(node, text) {
  node.hidden = false;
  node.className = "test-result pending";
  node.textContent = "";
  node.append(el("span", "activity"), el("span", null, text));
}

/** Green success, or the server's sentence verbatim (it is already readable). */
function testResult(node, res) {
  node.hidden = false;
  node.textContent = "";
  if (res && res.ok) {
    node.className = "test-result ok";
    node.textContent = res.model ? t("provider.testOk", { model: res.model }) : t("provider.testOkPlain");
    return true;
  }
  node.className = "test-result bad";
  node.textContent = String((res && res.error) || t("provider.testFailed"));
  return false;
}

let toastTimer = 0;
function toast(message, kind = "ok") {
  const t = $("toast");
  t.textContent = message;
  t.className = `toast ${kind}`;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 4000);
}

/** Report a rejected promise. A 401 already swapped the UI for the token gate. */
function fail(err) {
  const msg = err && err.message ? err.message : String(err);
  if (msg !== "Unauthorized") toast(msg, "error");
}

/* -------------------------------------------------------------------- token */

const TOKEN_KEY = "tca.token";
const SESSION_KEY = "tca.session";
let token = "";

/** Take ?token= out of the URL and scrub it from the address bar / history. */
function takeTokenFromUrl() {
  const url = new URL(location.href);
  const t = url.searchParams.get("token");
  if (!t) return "";
  url.searchParams.delete("token");
  const qs = url.searchParams.toString();
  history.replaceState(null, "", url.pathname + (qs ? `?${qs}` : "") + url.hash);
  return t;
}

function showGate(message) {
  closeStream();
  $("app").hidden = true;
  $("token-gate").hidden = false;
  const err = $("token-error");
  err.hidden = !message;
  err.textContent = message || "";
  $("token-input").value = "";
  $("token-input").focus();
}

function onUnauthorized() {
  token = "";
  store.del(TOKEN_KEY);
  showGate(t("gate.rejected"));
}

/* ----------------------------------------------------------------- http api */

/**
 * JSON fetch with the bearer token attached. Rejects on non-2xx; a 401 also
 * drops the stored token and re-opens the gate.
 */
async function api(path, { method = "GET", body } = {}) {
  const headers = { Authorization: `Bearer ${token}` };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(path, {
    method, headers, cache: "no-store",
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401) { onUnauthorized(); throw new Error("Unauthorized"); }
  if (!res.ok) {
    let msg = `${method} ${path} failed (${res.status})`;
    let payload = null;
    try {
      payload = await res.json();
      if (payload && (payload.error || payload.message)) msg = String(payload.error || payload.message);
    } catch {}
    const err = new Error(msg);
    err.status = res.status;
    // Some routes answer with a translation key instead of prose, so the caller
    // can show the message in the user's language. Carry it through.
    if (payload && payload.errKey) err.errKey = payload.errKey;
    if (payload) err.payload = payload;
    throw err;
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

/* ------------------------------------------------------- markdown renderer */

/**
 * Zero-dependency markdown renderer. Supports:
 * - Fenced code blocks (``` lang) with copy button
 * - Headings (# ## ###)
 * - Bold (**text**), italic (*text*), strikethrough (~~text~~), inline code
 * - Lists, ordered or not, nested to any depth, plus task lists (- [x] done)
 * - Blockquotes (> text)
 * - Horizontal rules (---)
 * - Links [text](url) - rendered as plain text for security (no innerHTML)
 * - Tables, with or without the outer pipes
 * Server/model output is untrusted: all text uses textContent, never innerHTML.
 * test/markdown.test.mjs loads this file into a DOM stub and pins the output.
 */

/** Split raw text into fenced-code and prose segments. */
function splitFences(src) {
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
function renderInline(text) {
  const frag = document.createDocumentFragment();
  // Pattern: `code` | **bold** | ~~strike~~ | *italic* | [link](url)
  // Code first, so `**not bold**` inside backticks stays literal.
  const re = /`([^`]+)`|\*\*(.+?)\*\*|~~(.+?)~~|\*(.+?)\*|\[([^\]]+)\]\(([^)]+)\)/g;
  let last = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
    if (m[1] != null) { const c = document.createElement('code'); c.className = 'inline-code'; c.textContent = m[1]; frag.appendChild(c); }
    else if (m[2] != null) { const b = document.createElement('strong'); b.textContent = m[2]; frag.appendChild(b); }
    else if (m[3] != null) { const s = document.createElement('s'); s.textContent = m[3]; frag.appendChild(s); }
    else if (m[4] != null) { const i = document.createElement('em'); i.textContent = m[4]; frag.appendChild(i); }
    else if (m[5] != null) {
      // Links: show as "text (url)" safely without opening innerHTML attack
      const span = document.createElement('span');
      span.className = 'md-link';
      const t = document.createElement('span'); t.textContent = m[5];
      const u = document.createElement('span'); u.className = 'md-link-url'; u.textContent = ` (${m[6]})`;
      span.append(t, u);
      frag.appendChild(span);
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
  return frag;
}

/* ------------------------------------------------- markdown block detection */

/** "  - item", "* item", "1. item", "2) item" - captures indent, marker, text. */
const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;

/** The |---|:--:| line under a table header. Must contain a dash. */
function isTableSeparator(line) {
  const s = (line || "").trim();
  return s.includes("-") && /^[|\s:-]+$/.test(s);
}

/** A table row starts a table only if the next line is its separator. */
function startsTable(lines, i) {
  return lines[i].includes("|") && i + 1 < lines.length && isTableSeparator(lines[i + 1]);
}

/**
 * Split a table row into cells. Both "| a | b |" and "a | b" are accepted: only
 * the outermost pipes are optional delimiters, which is what every markdown
 * dialect does and what models emit when they drop the outer pipes.
 */
function tableCells(line) {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  return s.split("|").map((c) => c.trim());
}

/** True when this line opens a block that a paragraph must not swallow. */
function startsBlock(lines, i) {
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

/**
 * Collect a run of list items, keeping each one's indent so nesting can be
 * rebuilt. An indented plain line continues the previous item.
 */
function collectListItems(lines, start) {
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
    // Lazy continuation: "  more text" under an item belongs to that item.
    if (items.length && lines[i].trim() && /^\s{2,}\S/.test(lines[i])) {
      items[items.length - 1].text += ` ${lines[i].trim()}`;
      i++;
      continue;
    }
    break;
  }
  return { items, next: i };
}

/** "[ ] thing" / "[x] thing" -> a checkbox glyph plus the rest. */
function listItemContent(text) {
  const task = /^\[([ xX])\]\s+(.*)$/.exec(text);
  if (!task) return renderInline(text);
  const frag = document.createDocumentFragment();
  const box = el("span", "md-task", task[1] === " " ? "\u2610" : "\u2611");
  frag.append(box, document.createTextNode(" "), renderInline(task[2]));
  return frag;
}

/**
 * Turn a flat item list into nested <ul>/<ol>. Deeper items go inside the last
 * <li>; a marker change at the same depth starts a sibling list.
 * @returns {{node: HTMLElement, next: number}}
 */
function buildList(items, from, indent) {
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
function renderProseLines(lines) {
  const frag = document.createDocumentFragment();
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Blank line
    if (!line.trim()) { i++; continue; }

    // Heading
    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      const tag = `h${heading[1].length + 2}`; // #->h3, ##->h4, ###->h5 (h1/h2 reserved for app)
      const h = document.createElement(tag);
      h.className = 'md-heading';
      h.appendChild(renderInline(heading[2]));
      frag.appendChild(h);
      i++; continue;
    }

    // Horizontal rule
    if (/^-{3,}$|^\*{3,}$|^_{3,}$/.test(line.trim())) {
      frag.appendChild(document.createElement('hr'));
      i++; continue;
    }

    // Blockquote
    if (line.startsWith('> ') || line === '>') {
      const bq = document.createElement('blockquote');
      bq.className = 'md-blockquote';
      const bqLines = [];
      while (i < lines.length && (lines[i].startsWith('> ') || lines[i] === '>')) {
        bqLines.push(lines[i].replace(/^>\s?/, ''));
        i++;
      }
      const inner = renderProseLines(bqLines);
      bq.appendChild(inner);
      frag.appendChild(bq);
      continue;
    }

    // Table
    if (startsTable(lines, i)) {
      const table = document.createElement('table');
      table.className = 'md-table';
      const thead = document.createElement('thead');
      const tbody = document.createElement('tbody');
      const tr = document.createElement('tr');
      for (const cell of tableCells(line)) {
        const th = document.createElement('th');
        th.appendChild(renderInline(cell));
        tr.appendChild(th);
      }
      thead.appendChild(tr);
      table.appendChild(thead);
      i += 2; // skip header + separator
      while (i < lines.length && lines[i].includes('|')) {
        const row = document.createElement('tr');
        for (const cell of tableCells(lines[i])) {
          const td = document.createElement('td');
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

    // Lists, ordered or not, nested to any depth
    if (LIST_ITEM.test(line)) {
      const { items, next } = collectListItems(lines, i);
      let k = 0;
      while (k < items.length) {
        const built = buildList(items, k, items[k].indent);
        frag.appendChild(built.node);
        k = built.next > k ? built.next : k + 1; // never stall
      }
      i = next;
      continue;
    }

    // Paragraph: collect consecutive lines until something else starts
    const paraLines = [];
    while (i < lines.length && !startsBlock(lines, i)) {
      paraLines.push(lines[i]);
      i++;
    }
    if (paraLines.length) {
      const p = document.createElement('p');
      p.className = 'md-para';
      p.appendChild(renderInline(paraLines.join(' ')));
      frag.appendChild(p);
    } else {
      i++; // defensive: never loop forever on an unrecognised line
    }
  }
  return frag;
}

/* --------------------------------------------------------- syntax highlight */

/**
 * Tiny syntax highlighter.
 *
 * Not a parser: one regex per language family, matched left to right, first
 * alternative wins. That is enough to make code readable and cannot be wrong in
 * a way that matters - a mis-coloured token is a cosmetic bug, and the text is
 * always the exact text the model sent.
 *
 * Built with createElement/textContent like everything else here. The renderer is
 * loaded into a DOM stub with no innerHTML on it (see test/markdown.test.mjs)
 * precisely so this file cannot quietly grow an injection hole.
 */

const KEYWORDS = {
  c: "as async await break case catch class const continue debugger default delete do else enum export extends finally for from function get if implements import in instanceof interface let new of private protected public readonly return satisfies set static super switch this throw try type typeof var void while with yield",
  py: "and as assert async await break class continue def del elif else except finally for from global if import in is lambda match new nonlocal not or pass raise return try while with yield None True False self",
  go: "break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var nil true false",
  rs: "as async await break const continue crate dyn else enum extern fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait type unsafe use where while",
  sh: "if then else elif fi for while do done case esac in function return exit local export readonly set unset source shift trap",
  sql: "select from where group by order having insert into values update set delete create table drop alter index join left right inner outer on as and or not null limit offset",
};

/** Which token grammar to use for a fence tag. */
const SYNTAX = {
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

/** Escape a string for use inside a regex alternative. */
function reEscape(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Build (and cache) the token regex for one language config. */
const grammarCache = new Map();
function grammarFor(name) {
  if (grammarCache.has(name)) return grammarCache.get(name);
  const cfg = SYNTAX[name];
  let grammar = null;
  if (cfg) {
    const parts = [];
    // Order matters: comments and strings must win over everything, or a keyword
    // inside a comment gets coloured as code.
    if (cfg.block) parts.push("(/\\*[\\s\\S]*?(?:\\*/|$))"); // 1 block comment
    else parts.push("(\\u0000)"); // keep the group numbering stable
    parts.push(cfg.line ? `(${reEscape(cfg.line)}[^\\n]*)` : "(\\u0000)"); // 2 line comment
    parts.push("(\"(?:[^\"\\\\\\n]|\\\\.)*\"|'(?:[^'\\\\\\n]|\\\\.)*'|`(?:[^`\\\\]|\\\\.)*`)"); // 3 string
    parts.push("(\\b\\d[\\w.]*\\b)"); // 4 number
    parts.push(cfg.kw ? `\\b(${cfg.kw.trim().split(/\s+/).map(reEscape).join("|")})\\b` : "(\\u0000)"); // 5 keyword
    parts.push("\\b([A-Za-z_$][\\w$]*)(?=\\s*\\()"); // 6 call
    parts.push(cfg.markup ? "(<[^>\\n]*>)" : "(\\u0000)"); // 7 tag
    grammar = new RegExp(parts.join("|"), "g");
  }
  grammarCache.set(name, grammar);
  return grammar;
}

const TOKEN_CLASS = ["tok-comment", "tok-comment", "tok-str", "tok-num", "tok-kw", "tok-fn", "tok-tag"];

/**
 * Highlighted code as a DocumentFragment. Unknown languages come back as one
 * plain text node, which is the right answer rather than a guess.
 */
function highlight(code, lang) {
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
    // A zero-length match would spin forever; the \u0000 placeholders can never
    // match real text but a malformed grammar still must not hang the page.
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

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fallback for contexts without the async clipboard API.
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

/** A <pre><code> block with a language tag, a Copy button and highlighting. */
function codeBlock(code, lang) {
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

/** Scrollable, focusable preformatted block holding untrusted text. */
function pre(text) {
  const p = el("pre");
  p.tabIndex = 0;
  p.appendChild(el("code", null, text == null ? "" : String(text)));
  return p;
}

/** True for tool output that carries a unified-diff hunk from write/edit/patch. */
function looksLikeDiff(text) {
  return typeof text === "string" && /^@@ -\d+,\d+ \+\d+,\d+ @@/m.test(text);
}

/**
 * Same as pre(), but each line of a diff gets a colour. Still one text node per
 * line - no innerHTML, because this is file content the model chose.
 */
function diffPre(text) {
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

/** pre() or diffPre(), whichever suits the text. */
const outputBlock = (text) => (looksLikeDiff(text) ? diffPre(text) : pre(text));

/** Render assistant text (markdown) into a container. */
function renderRich(container, raw) {
  container.textContent = "";
  for (const seg of splitFences(raw)) {
    if (seg.type === "code") {
      container.appendChild(codeBlock(seg.text, seg.lang));
    } else {
      const div = document.createElement('div');
      div.className = 'md-prose';
      div.appendChild(renderProseLines(seg.text.split('\n')));
      container.appendChild(div);
    }
  }
}

/* ----------------------------------------------------------- chat rendering */

const messagesEl = () => $("messages");
const BUSY = () => t("chat.working");

let state = null; // last /api/state payload
/**
 * build or plan. Held in the page as well as on the server because it is toggled
 * mid-conversation and rides along with each message; see send().
 */
let mode = "build";
let sessions = [];
let sessionId = null;
let streaming = false;
let stream = null; // EventSource, one per selected session
let turn = null; // { bubble, body, text:{node,raw}|null, footer, tools:Map }
let stick = true; // auto-scroll only while the user sits at the bottom
/** approval id -> settle(label), so the server can close a card the user ignored. */
const approvals = new Map();
/** Last /api/capabilities payload, kept so a language switch can repaint the
 *  Power panel without a refetch. */
let powerData = null;

/** The plan card, replaced in place rather than appended on every update. */
let todoCard = null;

const setStatus = (text) => ($("stream-status").textContent = text || "");

function setStreaming(on) {
  streaming = on;
  $("btn-send").disabled = on;
  $("btn-stop").hidden = !on;
  $("activity").hidden = !on;
  setStatus(on ? BUSY() : "");
}

function scrollToBottom(force) {
  const m = messagesEl();
  if (force) { stick = true; $("jump-latest").hidden = true; }
  if (stick) m.scrollTop = m.scrollHeight;
}

/** The message list, with the "no messages yet" placeholder dropped if present. */
function messageHost() {
  const m = messagesEl();
  const placeholder = m.querySelector(".empty");
  if (placeholder) placeholder.remove();
  return m;
}

/**
 * Append an empty message row and hand back its parts.
 *
 * Not a chat bubble. A coding transcript is mostly assistant prose, code and tool
 * output, and bubbles waste the horizontal space that a phone has least of - so
 * the role lives in a narrow gutter label and the body gets the full width.
 */
function makeBubble(role) {
  const bubble = el("article", `msg ${role}`);
  bubble.setAttribute("aria-label", role === "user" ? t("chat.you") : t("chat.assistant"));
  bubble.appendChild(el("div", "msg-gutter", role === "user" ? t("chat.you") : t("chat.assistant")));
  const body = el("div", "msg-body");
  bubble.appendChild(body);
  messageHost().appendChild(bubble);
  return { bubble, body };
}

function footerOf(t) {
  if (!t.footer) t.bubble.appendChild((t.footer = el("p", "msg-footer")));
  return t.footer;
}

/** Ensure there is an open assistant turn for streamed content. */
function ensureTurn() {
  if (turn) return turn;
  const { bubble, body } = makeBubble("assistant");
  turn = { bubble, body, text: null, footer: null, tools: new Map(), subs: new Map(), reasoning: null };
  scrollToBottom();
  return turn;
}

/**
 * Where an event's output belongs.
 *
 * Sub-agent events arrive tagged with the id of the sub-agent that produced them,
 * and they must land inside that sub-agent's block rather than in the parent's
 * transcript - otherwise a delegated investigation dumps twenty tool rows into
 * the middle of the answer and the nesting that made it worth delegating is
 * invisible.
 */
function hostFor(ev) {
  const cur = ensureTurn();
  if (ev && ev.subagent) {
    const sub = cur.subs.get(String(ev.subagent));
    if (sub) return sub.body;
  }
  return cur.body;
}

/**
 * A collapsed block for one delegated task.
 *
 * Open while it runs, because a phone user watching a two-minute sub-agent with
 * nothing on screen assumes the app has hung. Collapsed the moment it finishes,
 * because by then only its answer matters.
 */
function subagentBlock(ev) {
  const cur = ensureTurn();
  const id = String(ev.id);
  if (cur.subs.has(id)) return cur.subs.get(id);
  const badge = el("span", "tool-state", "\u2026");
  const sum = el("summary");
  sum.append(
    el("span", "tool-caret", "\u203a"),
    el("span", "tool-name", t("sub.title")),
    el("span", "tool-arg", ev.kind === "general" ? t("sub.kind.general") : t("sub.kind.explore")),
    badge,
  );
  const body = el("div", "tool-body");
  const block = el("details", "subagent");
  block.open = true;
  block.append(sum, body);
  cur.body.appendChild(block);
  cur.text = null; // text after this starts a new block, keeping stream order
  const handle = { block, badge, body, tools: new Map() };
  cur.subs.set(id, handle);
  scrollToBottom();
  return handle;
}

/**
 * The model's thinking, in a block that is collapsed by default.
 *
 * Reasoning models emit far more of this than of the answer, and on a phone
 * screen it buries the part the user asked for. But it is not hidden either: when
 * an agent goes wrong, the thinking is usually where you can see why.
 */
function reasoningBlock() {
  const cur = ensureTurn();
  if (cur.reasoning) return cur.reasoning;
  const sum = el("summary");
  sum.append(el("span", "tool-caret", "\u203a"), el("span", "tool-name", t("chat.thinking")));
  const node = el("div", "reason-body");
  const block = el("details", "reasoning");
  block.append(sum, node);
  cur.body.appendChild(block);
  cur.text = null;
  cur.reasoning = { block, node, raw: "" };
  return cur.reasoning;
}

/**
 * Re-rendering a whole text block per delta is fine at chat sizes, but do it at
 * most once a frame. Blocks are tracked by reference so a block that was closed
 * by a tool row still gets its final render.
 */
const dirtyBlocks = new Set();
let rafPending = false;

function scheduleRender(block) {
  dirtyBlocks.add(block);
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(flushRender);
}

function flushRender() {
  rafPending = false;
  for (const b of dirtyBlocks) {
    // Thinking is rendered as plain text on purpose: it is a stream of half
    // sentences, and running a markdown parser over it produces stray headings
    // and half-open code fences that flicker as more arrives.
    if (b.plain) b.node.textContent = b.raw;
    else renderRich(b.node, b.raw);
  }
  dirtyBlocks.clear();
  scrollToBottom();
}

/** @param {any} ev  the event, so sub-agent text lands inside its own block */
function appendDelta(text, ev) {
  const cur = ensureTurn();
  const host = hostFor(ev);
  const sub = ev && ev.subagent ? cur.subs.get(String(ev.subagent)) : null;
  const slot = sub || cur;
  if (!slot.text) {
    const node = el("div", "rich");
    host.appendChild(node);
    slot.text = { node, raw: "" };
  }
  slot.text.raw += String(text);
  scheduleRender(slot.text);
}

function appendReasoning(text) {
  const block = reasoningBlock();
  block.raw += String(text);
  block.plain = true;
  scheduleRender(block);
}

/** One-line summary of a tool's input object, for the collapsed row. */
function shortInput(input) {
  if (input == null) return "";
  if (typeof input === "string") return input;
  for (const k of ["command", "cmd", "path", "file", "pattern", "query", "url"]) {
    if (typeof input[k] === "string" && input[k]) return input[k];
  }
  try { return JSON.stringify(input); } catch { return ""; }
}

function prettyInput(input) {
  if (typeof input === "string") return input;
  try { return JSON.stringify(input, null, 2); } catch { return String(input); }
}

/**
 * Collapsed tool row - `> run_command  npm test`. <details> gives tap-to-expand
 * and keyboard support for free.
 */
function toolRow(container, name, input) {
  const badge = el("span", "tool-state", "\u2026");
  const sum = el("summary");
  sum.append(
    el("span", "tool-caret", "\u203a"),
    el("span", "tool-name", name || "tool"),
    el("span", "tool-arg", shortInput(input).slice(0, 160)),
    badge,
  );
  const body = el("div", "tool-body");
  body.append(el("p", "tool-label", t("tool.input")), pre(prettyInput(input)));
  const row = el("details", "tool");
  row.append(sum, body);
  container.appendChild(row);
  return { row, badge, body };
}

function finishToolRow(handle, ok, output) {
  handle.badge.textContent = ok ? t("tool.ok") : t("tool.error");
  handle.badge.classList.add(ok ? "ok" : "bad");
  if (!ok) handle.row.classList.add("bad");
  handle.body.append(el("p", "tool-label", t("tool.output")), outputBlock(output));
  // A file change is the interesting part of a turn: show the diff without a tap.
  if (ok && looksLikeDiff(output)) handle.row.open = true;
}

/** Inline approval card with Allow / Deny, posted to /api/approvals/:id. */
function approvalCard(ev) {
  const isEdit = ev.kind === "edit";
  const card = el("section", "approval");
  card.setAttribute("role", "group");
  card.setAttribute("aria-label", isEdit ? t("approval.edit.aria") : t("approval.command.aria"));
  card.tabIndex = -1;
  card.append(
    el("p", "approval-title", isEdit ? t("approval.edit.title") : t("approval.command.title")),
    pre(ev.command ?? ""),
  );
  if (ev.reason) card.appendChild(el("p", "small", String(ev.reason)));
  if (ev.cwd) card.appendChild(el("p", "muted small", t(isEdit ? "approval.workspace" : "approval.cwd", { path: ev.cwd })));

  const allow = el("button", "btn primary grow", t("approval.allow"));
  const deny = el("button", "btn danger grow", t("approval.deny"));
  allow.type = deny.type = "button";
  const row = el("div", "row");
  const result = el("p", "approval-result");
  result.hidden = true;

  /** Freeze the card once it can no longer be acted on. */
  const settle = (label) => {
    allow.disabled = deny.disabled = true;
    card.classList.add("resolved");
    result.textContent = label;
    result.hidden = false;
    row.hidden = true;
    approvals.delete(String(ev.id));
  };

  const decide = async (approved) => {
    allow.disabled = deny.disabled = true;
    try {
      await api(`/api/approvals/${encodeURIComponent(ev.id)}`, { method: "POST", body: { approved } });
      settle(approved ? t("approval.allowed") : t("approval.denied"));
    } catch (err) {
      allow.disabled = deny.disabled = false;
      fail(err);
    }
  };
  allow.addEventListener("click", () => decide(true));
  deny.addEventListener("click", () => decide(false));

  row.append(allow, deny);
  card.append(row, result);
  messageHost().appendChild(card);
  approvals.set(String(ev.id), settle);
  scrollToBottom();
  // The turn is blocked until this is answered, so it must be impossible to
  // miss: announce it, and move focus so a screen reader lands on it.
  toast(isEdit ? t("approval.toast.edit") : t("approval.toast.command"), "warn");
  try { card.focus({ preventScroll: true }); } catch { card.focus(); }
  return card;
}

/**
 * A short server-side notice (context nearly full, approval timed out). Goes in
 * the current turn so it keeps its place in the transcript.
 * @param {string} text
 * @param {"info"|"warn"} [kind]
 * @param {any} [ev]
 */
function noteLine(text, kind = "info", ev) {
  const host = turn ? hostFor(ev) : messageHost();
  host.appendChild(el("p", `tool-note ${kind}`, String(text)));
  if (turn) {
    const sub = ev && ev.subagent ? turn.subs.get(String(ev.subagent)) : null;
    (sub || turn).text = null; // later text starts a fresh block, preserving order
  }
  scrollToBottom();
}

/**
 * The agent's checklist, as one card that updates in place.
 *
 * Deliberately not appended per update: the model rewrites the whole list every
 * time it changes something, and a transcript with eight copies of a six-item
 * plan in it is unreadable on a phone. So the card is found and replaced.
 */
function renderTodo(items) {
  if (!Array.isArray(items) || !items.length) {
    if (todoCard) todoCard.remove();
    todoCard = null;
    return;
  }

  const done = items.filter((i) => i.status === "done").length;
  const card = el("section", "todo");
  card.setAttribute("role", "group");
  card.setAttribute("aria-label", t("todo.title"));

  const head = el("div", "todo-head");
  head.append(
    el("p", "todo-title", t("todo.title")),
    el("p", "todo-count", t("todo.progress", { done, total: items.length })),
  );
  card.appendChild(head);

  const bar = el("div", "todo-bar");
  bar.setAttribute("role", "img");
  bar.setAttribute("aria-label", t("todo.progress", { done, total: items.length }));
  const fill = el("span", "todo-bar-fill");
  fill.style.width = `${items.length ? Math.round((done / items.length) * 100) : 0}%`;
  bar.appendChild(fill);
  card.appendChild(bar);

  const list = el("ul", "todo-list");
  for (const item of items) {
    const status = ["pending", "in_progress", "done"].includes(item.status) ? item.status : "pending";
    const li = document.createElement("li");
    li.className = `todo-item ${status}`;
    const glyph = status === "done" ? "\u2713" : status === "in_progress" ? "\u203a" : "\u25cb";
    const mark = el("span", "todo-mark", glyph);
    mark.setAttribute("role", "img");
    mark.setAttribute("aria-label", t(`todo.status.${status}`));
    li.append(mark, el("span", "todo-text", String(item.text || "")));
    list.appendChild(li);
  }
  card.appendChild(list);

  if (todoCard) todoCard.replaceWith(card);
  else messageHost().appendChild(card);
  todoCard = card;
  scrollToBottom();
}

/**
 * Render one stored message from GET /api/sessions/:id.
 *
 * `results` is the tool message that followed this one. The two are stored
 * separately - an assistant message holds the calls, the next message holds their
 * output - so reloading a session used to redraw every tool row as an empty
 * pending one, because the outputs were in a message this function never saw.
 * @param {any} msg
 * @param {Map<string, {output: string, ok: boolean}>} [results]
 */
function renderStoredMessage(msg, results) {
  const role = msg.role === "user" ? "user" : "assistant";
  const { body } = makeBubble(role);
  if (role === "user") {
    body.appendChild(el("div", "prose", String(msg.content ?? "")));
    return;
  }
  if (msg.reasoning) {
    const sum = el("summary");
    sum.append(el("span", "tool-caret", "\u203a"), el("span", "tool-name", t("chat.thinking")));
    const block = el("details", "reasoning");
    block.append(sum, el("div", "reason-body", String(msg.reasoning)));
    body.appendChild(block);
  }
  if (msg.content) {
    const rich = el("div", "rich");
    renderRich(rich, String(msg.content));
    body.appendChild(rich);
  }
  for (const call of msg.toolCalls || []) {
    const got = results && results.get(String(call.id));
    const handle = toolRow(body, call.name, call.input);
    if (got) finishToolRow(handle, got.ok !== false, got.output);
    else handle.badge.textContent = t("tool.unknown");
  }
  if (msg.usage && (msg.usage.input || msg.usage.output)) {
    body.appendChild(
      el("p", "msg-footer", t("chat.tokens", { in: msg.usage.input || 0, out: msg.usage.output || 0 })),
    );
  }
}

function errorBubble(message) {
  const { body } = makeBubble("assistant");
  body.appendChild(el("div", "prose error-text", String(message || "Unknown error")));
  scrollToBottom();
}

/* --------------------------------------------------------------- SSE stream */

function closeStream() {
  if (stream) stream.close();
  stream = null;
}

function openStream(id) {
  closeStream();
  // EventSource cannot set headers, so the token rides in the query string.
  const url = `/api/sessions/${encodeURIComponent(id)}/events?token=${encodeURIComponent(token)}`;
  const es = new EventSource(url);
  stream = es;
  es.addEventListener("open", () => setStatus(streaming ? BUSY() : ""));
  es.addEventListener("message", (e) => {
    let data;
    try { data = JSON.parse(e.data); } catch { return; }
    handleEvent(data);
  });
  es.addEventListener("error", async () => {
    if (es !== stream) return; // stale stream from a previous session
    if (es.readyState === EventSource.CONNECTING) {
      // Routine on mobile (doze, network switch): the browser retries itself.
      setStatus(t("chat.reconnecting"));
      return;
    }
    setStatus(t("chat.disconnected"));
    try { await api("/api/state"); } catch {} // surfaces a 401 as the token gate
  });
}

/**
 * The running totals under the composer.
 *
 * Context and cost are the two numbers that decide what a user does next on a
 * phone - start a new session, or stop before the next step gets expensive - and
 * neither is guessable from the transcript, so they are always on screen.
 */
let spent = { cost: 0, input: 0, output: 0, cacheRead: 0 };
let meter = { used: 0, window: 0 };

function fmtTokens(n) {
  const v = Number(n) || 0;
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `${Math.round(v / 1000)}k`;
  return String(v);
}

function renderMeter() {
  const bar = $("ctx-fill");
  const label = $("ctx-label");
  if (!bar || !label) return;
  const win = meter.window || (state && state.contextWindow) || 0;
  const used = meter.used || 0;
  const pct = win ? Math.min(100, Math.round((used / win) * 100)) : 0;
  bar.style.width = `${pct}%`;
  bar.parentElement.classList.toggle("hot", pct >= 75);
  const parts = [];
  if (win) parts.push(t("meter.context", { pct, used: fmtTokens(used), window: fmtTokens(win) }));
  if (spent.cacheRead) parts.push(t("meter.cached", { n: fmtTokens(spent.cacheRead) }));
  if (spent.cost) parts.push(`$${spent.cost < 0.01 ? spent.cost.toFixed(4) : spent.cost.toFixed(3)}`);
  label.textContent = parts.join("  \u00b7  ");
}

function resetMeter() {
  spent = { cost: 0, input: 0, output: 0, cacheRead: 0 };
  meter = { used: 0, window: (state && state.contextWindow) || 0 };
  renderMeter();
}

function handleEvent(ev) {
  if (!ev || typeof ev.type !== "string") return;
  if (streaming) setStatus(BUSY()); // any event means we are connected again
  switch (ev.type) {
    case "step":
      // Only shown once it is far enough in to be worth knowing: a step counter
      // that reads "1 of 40" on every message is noise.
      if (streaming && ev.n >= 3) setStatus(t("chat.step", { n: ev.n, of: ev.of }));
      break;
    case "text_delta":
      if (!streaming) setStreaming(true); // e.g. page reloaded mid-turn
      appendDelta(ev.text || "", ev);
      break;
    case "reasoning_delta":
      if (!streaming) setStreaming(true);
      if (!ev.subagent) appendReasoning(ev.text || "");
      break;
    case "assistant_end": {
      // One assistant message ended. Close the open text block so the next one
      // starts fresh, and collapse the thinking now that the answer has landed.
      const cur = turn;
      if (cur) {
        flushRender();
        if (cur.reasoning) cur.reasoning.block.open = false;
        cur.text = null;
      }
      break;
    }
    case "tool_start": {
      if (!streaming) setStreaming(true);
      const cur = ensureTurn();
      const sub = ev.subagent ? cur.subs.get(String(ev.subagent)) : null;
      const handle = toolRow(hostFor(ev), ev.name, ev.input);
      (sub ? sub.tools : cur.tools).set(String(ev.id), handle);
      (sub || cur).text = null; // following text starts a new block, keeping stream order
      scrollToBottom();
      break;
    }
    case "tool_end": {
      const cur = ensureTurn();
      const sub = ev.subagent ? cur.subs.get(String(ev.subagent)) : null;
      const bag = sub ? sub.tools : cur.tools;
      let handle = bag.get(String(ev.id));
      if (!handle) {
        handle = toolRow(hostFor(ev), ev.name, ev.input); // tool_start missed
        bag.set(String(ev.id), handle);
        (sub || cur).text = null;
      }
      finishToolRow(handle, ev.ok !== false, ev.output);
      scrollToBottom();
      break;
    }
    case "subagent_start":
      if (!streaming) setStreaming(true);
      subagentBlock(ev);
      break;
    case "subagent_end": {
      const cur = ensureTurn();
      const sub = cur.subs.get(String(ev.id));
      if (sub) {
        sub.badge.textContent = ev.ok ? t("tool.ok") : t("tool.error");
        sub.badge.classList.add(ev.ok ? "ok" : "bad");
        if (!ev.ok) sub.block.classList.add("bad");
        // Its conclusion comes back as the parent's tool result, so the working
        // out has done its job and can get out of the way.
        sub.block.open = false;
      }
      cur.text = null;
      break;
    }
    case "compacting":
      noteLine(t("chat.compacting"), "info", ev);
      break;
    case "compacted":
      noteLine(t("chat.compacted", { before: fmtTokens(ev.before), after: fmtTokens(ev.after) }), "info", ev);
      break;
    case "approval_request":
      approvalCard(ev);
      break;
    case "approval_closed": {
      // The server stopped waiting (10-minute timeout, or the turn was aborted).
      const settle = approvals.get(String(ev.id));
      if (settle) settle(ev.outcome === "timeout" ? t("approval.timedOut") : t("approval.cancelled"));
      break;
    }
    case "tool_note":
      noteLine(ev.text || "", "warn", ev);
      break;
    case "todo":
      renderTodo(ev.items || []);
      break;
    case "title":
      // The first user message becomes the session title; reflect it right away
      // instead of waiting for the turn to end.
      if (ev.title && sessionId) {
        const s = sessions.find((x) => x.id === sessionId);
        if (s && s.title !== ev.title) { s.title = ev.title; fillSessionSelect(); }
      }
      break;
    case "usage": {
      spent.input += ev.input || 0;
      spent.output += ev.output || 0;
      spent.cacheRead += ev.cacheRead || 0;
      if (typeof ev.cost === "number") spent.cost += ev.cost;
      if (ev.contextWindow) meter.window = ev.contextWindow;
      if (ev.contextUsed) meter.used = ev.contextUsed;
      renderMeter();
      const bits = [t("chat.tokens", { in: ev.input ?? 0, out: ev.output ?? 0 })];
      if (ev.cacheRead) bits.push(t("chat.cacheHit", { n: fmtTokens(ev.cacheRead) }));
      if (typeof ev.cost === "number" && ev.cost > 0) bits.push(`$${ev.cost.toFixed(4)}`);
      footerOf(ensureTurn()).textContent = bits.join(" \u00b7 ");
      break;
    }
    case "done": {
      const odd = ev.stopReason && !["end_turn", "stop", "done"].includes(ev.stopReason);
      if (turn && odd) {
        const f = footerOf(turn);
        f.textContent = `${f.textContent ? `${f.textContent} \u00b7 ` : ""}${t("chat.stopped", { reason: ev.stopReason })}`;
      }
      flushRender(); // paint the final delta before letting go of the turn
      turn = null;
      setStreaming(false);
      scrollToBottom();
      loadSessions().catch(() => {}); // titles / counts change after a turn
      break;
    }
    case "error":
      flushRender();
      turn = null;
      setStreaming(false);
      errorBubble(ev.message);
      break;
    // ---- the package-install stream (POST /api/capabilities/install) ---------
    // Not SSE and not part of a turn, but the same shape, and the Power panel
    // reads them through its own reader. Named here so a new event type cannot be
    // added on the server without something in the UI acknowledging it.
    case "start":
    case "log":
    case "item_done":
      break;
  }
}

/* ----------------------------------------------------------------- sessions */

function sessionLabel(s) {
  const title = (s.title || "").trim() || t("chat.sessionFallback", { id: String(s.id).slice(0, 8) });
  return s.messageCount ? `${title} (${s.messageCount})` : title;
}

function fillSessionSelect() {
  const sel = $("session-select");
  sel.textContent = "";
  for (const s of sessions) sel.appendChild(option(s.id, sessionLabel(s)));
  if (sessionId) sel.value = sessionId;
  $("btn-delete-session").disabled = !sessionId;
}

async function loadSessions() {
  sessions = (await api("/api/sessions")) || [];
  fillSessionSelect();
}

async function selectSession(id) {
  sessionId = id;
  store.set(SESSION_KEY, id);
  fillSessionSelect();
  turn = null;
  todoCard = null;
  dirtyBlocks.clear();
  approvals.clear();
  setStreaming(false);
  messagesEl().textContent = "";
  resetMeter();
  const data = await api(`/api/sessions/${encodeURIComponent(id)}`);
  const messages = (data && data.messages) || [];
  let shown = 0;
  for (const [i, m] of messages.entries()) {
    if (m.role === "tool") continue; // drawn with the assistant message that called it
    const next = messages[i + 1];
    const results =
      next && next.role === "tool"
        ? new Map((next.results || []).map((r) => [String(r.id), r]))
        : null;
    renderStoredMessage(m, results);
    shown++;
  }
  if (!shown) {
    messagesEl().appendChild(el("p", "empty muted", t("chat.empty")));
  }
  openStream(id);
  scrollToBottom(true);
}

async function newSession() {
  const created = await api("/api/sessions", { method: "POST" });
  await loadSessions();
  // POST always returns an id; fall back to the freshest session, and give up
  // loudly rather than throwing on `sessions[0].id` of an empty list.
  const id = (created && created.id) || (sessions[0] && sessions[0].id);
  if (!id) throw new Error("Could not create a session");
  await selectSession(id);
  $("composer-input").focus();
}

async function deleteSession() {
  if (!sessionId) return;
  const current = sessions.find((s) => s.id === sessionId);
  const label = current ? sessionLabel(current) : sessionId;
  if (!confirm(t("chat.deleteConfirm", { name: label }))) return;
  closeStream();
  await api(`/api/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE" });
  sessionId = null;
  await loadSessions();
  if (!sessions.length) await newSession();
  else await selectSession(sessions[0].id);
  toast(t("chat.deleted"));
}

/* ----------------------------------------------------------------- composer */

function autogrow() {
  const ta = $("composer-input");
  ta.style.height = "auto";
  const view = (window.visualViewport && window.visualViewport.height) || window.innerHeight;
  ta.style.height = `${Math.min(ta.scrollHeight, Math.round(view * 0.4))}px`;
}

async function send() {
  const ta = $("composer-input");
  const text = ta.value.trim();
  if (!text || streaming || !sessionId) return;
  makeBubble("user").body.appendChild(el("div", "prose", text));
  ta.value = "";
  autogrow();
  scrollToBottom(true);
  setStreaming(true); // the reply itself arrives over SSE
  try {
    // The mode goes with the message rather than being read from the config on
    // the server: the toggle and Send are one gesture, and a config write that
    // has not landed yet must not decide whether the agent can edit files.
    await api(`/api/sessions/${encodeURIComponent(sessionId)}/message`, {
      method: "POST",
      body: { text, mode },
    });
  } catch (err) {
    setStreaming(false);
    if (err.message !== "Unauthorized") errorBubble(err.message);
  }
}

async function abort() {
  if (!sessionId) return;
  try {
    await api(`/api/sessions/${encodeURIComponent(sessionId)}/abort`, { method: "POST" });
    setStatus(t("ui.stopping"));
  } catch (err) {
    fail(err);
  }
}

/* ----------------------------------------------------------------- settings */

const KEEP = "__keep__"; // server holds a key it will not show us
let cfg = null; // working copy of the config object
let provId = null; // provider currently shown in the form
let settingsLoaded = false;
let modelChoices = []; // catalog (or live) models behind the Settings picker

/** Show/hide the stored API key. Also used to unmask ${ENV} placeholders. */
function setKeyVisible(show) {
  const btn = $("btn-toggle-key");
  $("prov-apikey").type = show ? "text" : "password";
  btn.textContent = show ? t("provider.hide") : t("provider.show");
  btn.setAttribute("aria-pressed", String(show));
}

function fillProvider() {
  const p = (cfg.providers && cfg.providers[provId]) || {};
  $("prov-kind").value = p.kind === "anthropic" ? "anthropic" : "openai";
  $("prov-baseurl").value = p.baseUrl || "";
  $("prov-maxtokens").value = p.maxTokens ?? 8192;
  $("prov-model").value = p.model || "";

  const list = $("model-list");
  list.textContent = "";
  for (const m of p.models || []) list.appendChild(option(m, m));

  // Empty field for a kept key, and remember to send the sentinel back
  // untouched. ${ENV_VAR} placeholders are not secrets, so show them verbatim.
  const key = $("prov-apikey");
  if (p.apiKey === KEEP) {
    key.value = "";
    key.placeholder = "\u2022\u2022\u2022\u2022\u2022\u2022 stored on server";
    key.dataset.keep = "1";
  } else {
    key.value = p.apiKey || "";
    key.placeholder = "sk-\u2026 or ${ENV_NAME}";
    delete key.dataset.keep;
  }
  setKeyVisible(PLACEHOLDER_KEY.test(p.apiKey || ""));
  // Removing the last provider is allowed - it just leaves an empty draft
  // in its place (same as the very first run), instead of being blocked.
  $("btn-remove-provider").disabled = !provId || !cfg.providers || !cfg.providers[provId];
  renderSavedModelIds();

  $("provider-test-result").hidden = true;
  fillModelPicker().catch(() => {}); // note element already carries the reason
}

/**
 * Chips for the model ids saved against the current provider (p.models),
 * so you can switch between several without retyping. Click a chip to make
 * it active, tap x to drop it. "+ Save" (wired below) is what adds one.
 */
function renderSavedModelIds() {
  const host = $("saved-model-ids");
  host.textContent = "";
  const p = (cfg.providers && cfg.providers[provId]) || {};
  const models = Array.isArray(p.models) ? p.models : [];
  if (!models.length) {
    host.appendChild(el("p", "muted small", t("ui.noSavedIds")));
    return;
  }
  for (const m of models) {
    const chip = el("span", "chip");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "chip-main";
    btn.textContent = m;
    btn.title = "Use this model id";
    btn.addEventListener("click", () => {
      $("prov-model").value = m;
      $("prov-model").dispatchEvent(new Event("input"));
    });
    const rm = document.createElement("button");
    rm.type = "button";
    rm.className = "chip-x";
    rm.textContent = "\u00d7";
    rm.setAttribute("aria-label", `Remove saved model id ${m}`);
    rm.addEventListener("click", () => {
      p.models = models.filter((x) => x !== m);
      renderSavedModelIds();
      toast(t("ui.removedRememberSave"));
    });
    chip.append(btn, rm);
    host.appendChild(chip);
  }
}

function saveCurrentModelId() {
  const id = $("prov-model").value.trim();
  if (!id) return toast(t("ui.pickModelFirst"), "error");
  const p = (cfg.providers && cfg.providers[provId]) || {};
  if (!Array.isArray(p.models)) p.models = [];
  if (p.models.includes(id)) return toast(t("ui.alreadySaved", { id }));
  p.models.push(id);
  renderSavedModelIds();
  toast(t("ui.savedRememberSave"));
}

function fillSettings() {
  const sel = $("active-provider");
  sel.textContent = "";
  for (const id of Object.keys(cfg.providers || {})) sel.appendChild(option(id, id));
  sel.value = provId;
  $("cfg-workspace").value = cfg.workspace || "";
  $("cfg-autoapprove").checked = Boolean(cfg.autoApproveCommands);
  // Absent in configs written before this option existed, and the default is on.
  $("cfg-autoapprove-edits").checked = cfg.autoApproveEdits !== false;
  $("cfg-lang").value = normaliseLang(cfg.lang || lang);
  $("cfg-maxsteps").value = cfg.maxSteps ?? 40;
  $("cfg-instructions").value = cfg.instructions || "";
  $("cfg-deny").value = (cfg.denyCommands || []).join("\n");
  fillProvider();
}

/* -------------------------------------------------- settings: model picker */

/**
 * Fill the Settings model <select> (and the free-text datalist) for the provider
 * currently shown. Pass `{models, note}` to display live models instead of the
 * bundled/downloaded catalog.
 * @param {{models: object[], note?: string}} [override]
 */
async function fillModelPicker(override) {
  const sel = $("model-picker");
  const note = $("model-picker-note");
  sel.textContent = "";
  sel.appendChild(option("", "\u2014 choose from catalog \u2014"));
  note.className = "muted small";

  let list = override && override.models;
  if (list) {
    note.textContent = override.note || "";
  } else {
    note.textContent = "Loading model list\u2026";
    try {
      const res = await api(`/api/catalog?provider=${encodeURIComponent(provId)}`);
      list = (res && res.models) || [];
      note.textContent = list.length
        ? `${list.length} models known for "${provId}".`
        : `No catalog entry for "${provId}". Type the model id below, or use "Refresh from provider".`;
    } catch (err) {
      list = [];
      note.className = "warn small";
      note.textContent = err.message;
    }
  }

  modelChoices = list;
  const dl = $("model-list");
  dl.textContent = "";
  const seen = new Set();
  for (const m of list) {
    if (!m || !m.id || seen.has(m.id)) continue;
    seen.add(m.id);
    sel.appendChild(option(m.id, modelLabel(m)));
    dl.appendChild(option(m.id, m.name || m.id));
  }
  // Ids saved in the config but missing from the catalog stay suggestable.
  for (const m of (cfg && cfg.providers && cfg.providers[provId] && cfg.providers[provId].models) || []) {
    if (!seen.has(m)) { seen.add(m); dl.appendChild(option(m, m)); }
  }
  const current = $("prov-model").value.trim();
  sel.value = seen.has(current) ? current : "";
}

function renderCatalogInfo() {
  const info = (state && state.catalog) || (providersInfo && providersInfo.catalog) || null;
  const line = $("catalog-info");
  const btn = $("btn-download-catalog");
  if (!info) { line.textContent = ""; return; }
  line.textContent = t("catalog.info", {
    source: t(info.source === "full" ? "catalog.source.full" : "catalog.source.seed"),
    models: info.modelCount,
    providers: info.providerCount,
    generated: info.generated,
  });
  btn.textContent = info.source === "full"
    ? t("catalog.redownload")
    : t("catalog.download");
}

async function downloadCatalog() {
  const btn = $("btn-download-catalog");
  if (!confirm(t("catalog.downloadConfirm"))) {
    return;
  }
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = t("catalog.downloading");
  try {
    const res = await api("/api/catalog/download", { method: "POST" });
    if (res && res.catalog && state) state.catalog = res.catalog;
    providersInfo = null; // provider list is cheap; re-fetch with fresh counts
    renderCatalogInfo();
    await fillModelPicker();
    toast(t("catalog.updated", { models: res.models, providers: res.providers }));
  } catch (err) {
    fail(err);
  } finally {
    btn.disabled = false;
    btn.textContent = label;
    renderCatalogInfo();
  }
}

/** Real 1-token request against the provider as stored on the server. */
async function testActiveProvider() {
  const btn = $("btn-test-provider");
  const out = $("provider-test-result");
  const model = $("prov-model").value.trim();
  btn.disabled = true;
  testPending(out, t("provider.testing"));
  try {
    const res = await api("/api/providers/test", {
      method: "POST",
      body: { id: provId, ...(model ? { model } : {}) },
    });
    testResult(out, res);
  } catch (err) {
    if (err.message === "Unauthorized") out.hidden = true;
    else testResult(out, { ok: false, error: err.message });
  } finally {
    btn.disabled = false;
  }
}

/** Ask the provider itself - the only way to know what a local server loaded. */
async function refreshLiveModels() {
  const btn = $("btn-refresh-live");
  const note = $("model-picker-note");
  btn.disabled = true;
  note.className = "muted small";
  note.textContent = "Asking the provider\u2026";
  try {
    const res = await api(`/api/models/live?provider=${encodeURIComponent(provId)}`);
    const models = (res && res.models) || [];
    await fillModelPicker({
      models,
      note: models.length
        ? `${models.length} models reported by ${provId} right now.`
        : `${provId} reported no models. Load one on the server, then refresh.`,
    });
  } catch (err) {
    if (err.message !== "Unauthorized") {
      note.className = "warn small";
      note.textContent = err.message;
    }
  } finally {
    btn.disabled = false;
  }
}

/* ------------------------------------------- settings: cross-provider search */

let searchTimer = 0;

function scheduleModelSearch(query) {
  clearTimeout(searchTimer);
  const q = query.trim();
  $("model-search-note").hidden = true;
  if (!q) { $("model-search-results").textContent = ""; return; }
  searchTimer = setTimeout(() => runModelSearch(q), 250);
}

async function runModelSearch(q) {
  const host = $("model-search-results");
  host.textContent = "";
  host.appendChild(el("p", "muted small", t("ui.searching")));
  try {
    const res = await api(`/api/catalog/search?q=${encodeURIComponent(q)}`);
    renderHits((res && res.hits) || []);
  } catch (err) {
    host.textContent = "";
    if (err.message !== "Unauthorized") host.appendChild(el("p", "warn small", err.message));
  }
}

function renderHits(hits) {
  const host = $("model-search-results");
  host.textContent = "";
  if (!hits.length) {
    host.appendChild(el("p", "muted small", t("ui.noMatch")));
    return;
  }
  for (const hit of hits) {
    const btn = el("button", `hit${hit.known ? "" : " unknown"}`);
    btn.type = "button";
    btn.append(el("span", "hit-title", `${hit.providerName} \u2014 ${hit.model.name || hit.model.id}`));
    const meta = [hit.model.id, fmtContext(hit.model.context), fmtPrice(hit.model)].filter(Boolean).join(" \u00b7 ");
    btn.append(el("span", "hit-meta", meta));
    if (!hit.known) btn.append(el("span", "hit-warn", t("ui.manualBaseUrl")));
    btn.addEventListener("click", () => selectHit(hit));
    host.appendChild(btn);
  }
}

/**
 * Act on a search hit. Providers outside the built-in table have no known base
 * URL, so they are refused with an explanation instead of half-working.
 */
function selectHit(hit) {
  const note = $("model-search-note");
  if (!hit.known) {
    note.hidden = false;
    note.textContent =
      `tca does not know the base URL for "${hit.providerName}", so it cannot be selected here. ` +
      `Use "Add provider", choose "Other (OpenAI-compatible)", and paste the base URL - ` +
      `then set the model id to "${hit.model.id}".`;
    return;
  }
  note.hidden = true;
  if (cfg && cfg.providers && cfg.providers[hit.providerId]) {
    readProvider(); // keep edits to the provider we are leaving
    provId = hit.providerId;
    cfg.active = provId;
    cfg.providers[provId].model = hit.model.id;
    fillSettings();
    toast(t("ui.pickedRememberSave", { provider: hit.providerName, model: hit.model.id }));
    return;
  }
  // Known provider, not configured yet: the wizard collects key + base URL.
  toast(t("ui.finishingSetup", { provider: hit.providerName }));
  enterWizard({ returnTo: "settings", providerId: hit.providerId, model: hit.model.id }).catch(fail);
}

/* ------------------------------------------------------- settings: the form */

function readProvider() {
  if (!cfg.providers) cfg.providers = {};
  const p = (cfg.providers[provId] = cfg.providers[provId] || {});
  p.kind = $("prov-kind").value;
  p.baseUrl = $("prov-baseurl").value.trim();
  p.model = $("prov-model").value.trim();
  p.maxTokens = Number($("prov-maxtokens").value) || 8192;
  if (!Array.isArray(p.models)) p.models = [];
  const key = $("prov-apikey");
  p.apiKey = key.dataset.keep === "1" && key.value === "" ? KEEP : key.value.trim();
}

/** Copy the whole form back into `cfg`. Untouched keys (e.g. port) survive. */
function readSettings() {
  readProvider();
  cfg.active = provId;
  cfg.workspace = $("cfg-workspace").value.trim();
  cfg.autoApproveCommands = $("cfg-autoapprove").checked;
  cfg.autoApproveEdits = $("cfg-autoapprove-edits").checked;
  cfg.lang = normaliseLang($("cfg-lang").value);
  cfg.maxSteps = Number($("cfg-maxsteps").value) || 40;
  cfg.instructions = $("cfg-instructions").value;
  cfg.denyCommands = $("cfg-deny").value.split("\n").map((s) => s.trim()).filter(Boolean);
}

async function loadSettings(announce) {
  cfg = await api("/api/config");
  if (!cfg.providers) cfg.providers = {};
  // Kept so the language switch can PUT a full config without a re-read.
  serverConfig = cfg;
  // The server is the source of truth for language; follow it unless the user
  // has already picked one in this browser.
  if (cfg.lang && !store.get(LANG_KEY)) setLang(cfg.lang, { persistToServer: false });
  const ids = Object.keys(cfg.providers);
  provId = cfg.providers[cfg.active] ? cfg.active : ids[0] || null;
  if (!provId) {
    // Empty config: offer something editable rather than a dead form.
    provId = "openai";
    cfg.providers[provId] = { kind: "openai", baseUrl: "", apiKey: "", model: "", models: [] };
  }
  fillSettings();
  renderCatalogInfo();
  settingsLoaded = true;
  if (announce) toast(t("ui.configReloaded"));
}

async function saveSettings() {
  readSettings();
  try {
    const res = await api("/api/config", { method: "PUT", body: cfg });
    toast(t("ui.savedTo", { path: (res && res.path) || "config" }));
    await refreshState(); // header provider/model may have changed
    await loadSettings(false); // re-read, so kept keys go back to the sentinel
  } catch (err) {
    fail(err);
  }
}

function addProvider() {
  // The wizard already knows every provider, its base URL, wire format and
  // catalog, so "add provider" is the same three questions as first run.
  enterWizard({ returnTo: "settings" }).catch(fail);
}

function removeProvider() {
  const remaining = Object.keys(cfg.providers || {}).filter((id) => id !== provId);
  const msg = remaining.length
    ? `Remove provider "${provId}"?`
    : `Remove provider "${provId}"? This is your only provider - you will need to add another before you can chat.`;
  if (!confirm(msg)) return;
  delete cfg.providers[provId];
  if (remaining.length) {
    provId = remaining[0];
  } else {
    // Same empty draft loadSettings() shows on a fresh config, so the form
    // never goes dead.
    provId = "openai";
    cfg.providers[provId] = { kind: "openai", baseUrl: "", apiKey: "", model: "", models: [] };
  }
  cfg.active = provId;
  fillSettings();
  toast(t("ui.removedSaveToPersist"));
}

/* ---------------------------------------------------- provider discovery api */

/** Tier copy is duplicated from src/recommended.js (TIERS) on purpose. */
const TIERS = {
  start: { label: "Start here", hint: "Reliable defaults if you are not sure." },
  cheap: { label: "Cheap or free", hint: "Good value; fine for most edits." },
  max: { label: "Maximum capability", hint: "Expensive. Use for hard problems." },
};
const TIER_ORDER = ["start", "cheap", "max"];

let providersInfo = null; // GET /api/providers, cached for the page

async function loadProviders(force) {
  if (providersInfo && !force) return providersInfo;
  providersInfo = await api("/api/providers");
  return providersInfo;
}

/** Curated entry for a provider id, including the "other" pseudo-provider. */
function providerEntry(id) {
  if (!providersInfo) return null;
  if (id === "other") return providersInfo.other || null;
  return (providersInfo.known || []).find((p) => p.id === id) || null;
}

function providerName(id) {
  const entry = providerEntry(id);
  return (entry && entry.name) || id;
}

/* --------------------------------------------------------- first-run wizard */

/**
 * Draft state for the wizard. Nothing is written to the server until Finish,
 * so Back never loses work and a half-finished draft cannot break the config.
 * @type {null | {
 *   step: number, providerId: string, entry: object|null, model: string,
 *   apiKey: string, baseUrl: string, kind: string, label: string,
 *   returnTo: "chat"|"settings"
 * }}
 */
let wiz = null;

const wizStatus = (text, bad) => {
  const p = $("wizard-status");
  p.className = bad ? "meta warn" : "meta muted";
  p.textContent = text || "";
};

/** Steps in play. The API-key step is meaningless for on-device runtimes. */
function stepList() {
  return wiz && wiz.entry && wiz.entry.local ? [1, 3, 4] : [1, 2, 3, 4];
}

function isOther() {
  return Boolean(wiz && (wiz.providerId === "other" || !(wiz.entry && wiz.entry.baseUrl)));
}

/**
 * @param {object} [opts]
 * @param {"chat"|"settings"} [opts.returnTo] where Finish/Skip lands
 * @param {string} [opts.providerId] preselect a provider (search hit, retry)
 * @param {string} [opts.model]
 */
async function enterWizard(opts = {}) {
  wiz = {
    step: 1,
    providerId: "",
    entry: null,
    model: "",
    apiKey: "",
    baseUrl: "",
    kind: "openai",
    label: "",
    returnTo: opts.returnTo === "settings" ? "settings" : "chat",
  };
  showView("wizard");
  wizStatus("Loading the provider list\u2026");
  try {
    await loadProviders(false);
  } catch (err) {
    if (err.message !== "Unauthorized") wizStatus(err.message, true);
    return;
  }
  wizStatus("");
  renderRecommended();
  renderAllProviders();
  if (opts.providerId && providerEntry(opts.providerId)) {
    chooseProvider(opts.providerId, opts.model || "");
    goStep(stepList()[1]);
  } else {
    goStep(1);
  }
}

/** Leave the wizard for a normal tab. */
function exitWizard(target) {
  wiz = null;
  switchTab(target === "settings" ? "settings" : "chat");
}

function tierGroup(host, label, hint) {
  const head = el("div", "tier-head");
  head.appendChild(el("h3", "tier-label", label));
  if (hint) head.appendChild(el("p", "tier-hint muted small", hint));
  host.appendChild(head);
}

/** A tappable card: title, one-line reason, provider name. */
function pickCard(providerId, model, title, why) {
  const card = el("button", "card");
  card.type = "button";
  card.dataset.provider = providerId;
  card.dataset.model = model || "";
  card.appendChild(el("span", "card-title", title));
  if (why) card.appendChild(el("span", "card-why", why));
  const meta = [providerName(providerId), model].filter(Boolean).join(" \u00b7 ");
  card.appendChild(el("span", "card-meta", meta));
  card.addEventListener("click", () => {
    chooseProvider(providerId, model || "");
    goStep(stepList()[1]);
  });
  return card;
}

function renderRecommended() {
  const host = $("wiz-recommended");
  host.textContent = "";
  const recs = (providersInfo && providersInfo.recommended) || [];
  const tiers = [...TIER_ORDER, ...new Set(recs.map((r) => r.tier).filter((t) => !TIER_ORDER.includes(t)))];
  for (const tier of tiers) {
    const group = recs.filter((r) => r.tier === tier);
    if (!group.length) continue;
    const copy = TIERS[tier] || { label: tier, hint: "" };
    tierGroup(host, copy.label, copy.hint);
    for (const r of group) host.appendChild(pickCard(r.provider, r.model, r.label, r.why));
  }
  if (!recs.length) host.appendChild(el("p", "muted small", t("ui.noRecommendations")));
}

function renderAllProviders() {
  const host = $("wiz-all");
  host.textContent = "";
  const known = [...((providersInfo && providersInfo.known) || [])].sort(
    (a, b) => (a.rank ?? 50) - (b.rank ?? 50),
  );
  const hosted = known.filter((p) => !p.local);
  const local = known.filter((p) => p.local);

  tierGroup(host, "Needs an API key", "Hosted providers. Sorted by how easy they are to start with.");
  for (const p of hosted) host.appendChild(pickCard(p.id, "", p.name, p.note || ""));

  if (local.length) {
    tierGroup(host, "Runs on your device", "No API key. You supply the model file and the server.");
    for (const p of local) host.appendChild(pickCard(p.id, "", p.name, p.note || ""));
  }

  const other = providersInfo && providersInfo.other;
  if (other) {
    tierGroup(host, "Anything else", "");
    host.appendChild(pickCard(other.id, "", other.name, other.note || ""));
  }
}

function chooseProvider(id, model) {
  const entry = providerEntry(id);
  wiz.providerId = id;
  wiz.entry = entry;
  wiz.kind = (entry && entry.kind) || "openai";
  wiz.baseUrl = (entry && entry.baseUrl) || "";
  wiz.model = model || "";
  wiz.apiKey = "";
  wiz.label = "";
  markChosenCard();
}

function markChosenCard() {
  for (const card of document.querySelectorAll("#panel-wizard .card")) {
    const on = wiz && card.dataset.provider === wiz.providerId && card.dataset.model === (wiz.model || "");
    card.classList.toggle("selected", on);
    card.setAttribute("aria-pressed", String(on));
  }
}

/** "Anthropic - claude-sonnet-5" line shown at the top of later steps. */
function chosenText() {
  if (!wiz) return "";
  return [providerName(wiz.providerId), wiz.model].filter(Boolean).join(" \u00b7 ");
}

function goStep(step) {
  wiz.step = step;
  for (const n of [1, 2, 3, 4]) $(`wizard-${n}`).hidden = n !== step;

  const list = stepList();
  for (const n of [1, 2, 3, 4]) {
    const tick = $(`wizard-tick-${n}`);
    const skipped = !list.includes(n);
    tick.classList.toggle("current", n === step);
    tick.classList.toggle("done", list.indexOf(n) > -1 && list.indexOf(n) < list.indexOf(step));
    tick.classList.toggle("skip", skipped);
    if (n === step) tick.setAttribute("aria-current", "step");
    else tick.removeAttribute("aria-current");
  }

  const last = step === list[list.length - 1];
  const next = $("btn-wiz-next");
  next.textContent = last ? "Finish" : "Next";
  next.classList.toggle("primary", !last); // on step 4, Test is the primary action
  $("btn-wiz-back").disabled = step === list[0];
  wizStatus("");

  if (step === 2) renderStep2();
  if (step === 3) renderStep3();
  if (step === 4) renderStep4();
  if (step === 1) markChosenCard();
  $("panel-wizard").scrollTop = 0;
}

function goRelative(delta) {
  const list = stepList();
  const at = list.indexOf(wiz.step);
  if (delta > 0) {
    const problem = validateStep(wiz.step);
    if (problem) return wizStatus(problem, true);
    if (at === list.length - 1) return wizardFinish();
  }
  const target = list[Math.min(list.length - 1, Math.max(0, at + delta))];
  goStep(target);
}

function validateStep(step) {
  if (step === 1 && !wiz.providerId) return "Tap one of the cards first.";
  if (step === 2) {
    if (isOther() && !readOtherFields()) return "Paste the base URL for this provider.";
    if (!wiz.apiKey) return "Paste the API key, or use ${ENV_NAME} to read it from the environment.";
  }
  if (step === 3) {
    wiz.model = $("wiz-model").value.trim();
    if (wiz.entry && wiz.entry.local) wiz.baseUrl = $("wiz-local-baseurl").value.trim() || wiz.baseUrl;
    if (!wiz.model) return "A model id is required. Pick one, or type it in.";
    if (!wiz.baseUrl) return "A base URL is required.";
  }
  return "";
}

/** Copy the "other" fields into the draft; returns false when baseUrl is empty. */
function readOtherFields() {
  wiz.label = $("wiz-label").value.trim();
  wiz.baseUrl = $("wiz-baseurl").value.trim();
  wiz.kind = $("wiz-kind").value === "anthropic" ? "anthropic" : "openai";
  return Boolean(wiz.baseUrl);
}

function renderStep2() {
  $("wiz-chosen-2").textContent = chosenText();
  const entry = wiz.entry || {};
  $("wiz-provider-note").textContent = entry.note || "";

  const link = $("wiz-key-link");
  link.textContent = "";
  if (typeof entry.keyUrl === "string" && /^https:\/\//.test(entry.keyUrl)) {
    const a = el("a", "keylink", t("ui.getApiKey"));
    a.href = entry.keyUrl;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    link.append(a, el("span", "muted small", ` \u2014 ${entry.keyUrl}`));
  }

  const other = isOther();
  $("wiz-other-fields").hidden = !other;
  if (other) {
    $("wiz-label").value = wiz.label || (wiz.providerId === "other" ? "" : wiz.providerId);
    $("wiz-baseurl").value = wiz.baseUrl || "";
    $("wiz-kind").value = wiz.kind;
  }

  const key = $("wiz-apikey");
  key.value = wiz.apiKey || "";
  key.placeholder = entry.keyPrefix ? `${entry.keyPrefix}\u2026` : "sk-\u2026 or ${ENV_NAME}";
  setWizKeyVisible(false);
  checkKeyPrefix();
}

function setWizKeyVisible(show) {
  const btn = $("btn-wiz-toggle-key");
  $("wiz-apikey").type = show ? "text" : "password";
  btn.textContent = show ? t("provider.hide") : t("provider.show");
  btn.setAttribute("aria-pressed", String(show));
}

/** Non-blocking: prefixes change, and ${ENV_NAME} is always allowed. */
function checkKeyPrefix() {
  const warnEl = $("wiz-key-warning");
  const prefix = wiz.entry && wiz.entry.keyPrefix;
  const value = wiz.apiKey || "";
  const odd = prefix && value && !value.startsWith(prefix) && !PLACEHOLDER_KEY.test(value);
  warnEl.hidden = !odd;
  warnEl.textContent = odd
    ? `That does not look right: keys for this provider usually start with ${prefix}. You can continue anyway.`
    : "";
}

function renderStep3() {
  $("wiz-chosen-3").textContent = chosenText();
  const local = Boolean(wiz.entry && wiz.entry.local);
  $("wiz-local-fields").hidden = !local;
  if (local) $("wiz-local-baseurl").value = wiz.baseUrl || "";
  $("wiz-model").value = wiz.model || "";
  loadWizardModels(local ? "live" : "catalog").catch(() => {});
}

/**
 * Populate the step-3 picker. Local runtimes only know their own model list, so
 * they are asked directly; everything else comes from the catalog.
 * @param {"catalog"|"live"} source
 */
async function loadWizardModels(source) {
  const sel = $("wiz-model-select");
  const dl = $("wiz-model-list");
  const note = $("wiz-model-note");
  sel.textContent = "";
  dl.textContent = "";
  sel.appendChild(option("", "\u2014 choose a model \u2014"));
  note.className = "muted small";
  note.textContent = "Loading model list\u2026";

  const id = encodeURIComponent(wiz.providerId);
  try {
    const res = await api(source === "live" ? `/api/models/live?provider=${id}` : `/api/catalog?provider=${id}`);
    const models = (res && res.models) || [];
    for (const m of models) {
      if (!m || !m.id) continue;
      sel.appendChild(option(m.id, source === "live" ? m.id : modelLabel(m)));
      dl.appendChild(option(m.id, m.name || m.id));
    }
    if (wiz.model && models.some((m) => m.id === wiz.model)) sel.value = wiz.model;
    if (models.length) {
      note.textContent =
        source === "live"
          ? `${models.length} models loaded from the server.`
          : `${models.length} models in the catalog. Prices are per 1M tokens and drift.`;
    } else {
      note.textContent =
        source === "live"
          ? "The server reported no models. Load one, then tap the button above."
          : "Nothing in the catalog for this provider - type the model id yourself.";
    }
  } catch (err) {
    if (err.message === "Unauthorized") return;
    note.className = "warn small";
    note.textContent =
      `${err.message} \u2014 type the model id by hand, or finish setup and use ` +
      `"Refresh from provider" in Settings.`;
  }
}

function summaryRow(host, label, value) {
  host.appendChild(el("dt", null, label));
  host.appendChild(el("dd", null, value));
}

function renderStep4() {
  const host = $("wiz-summary");
  host.textContent = "";
  const draft = wizardDraft();
  summaryRow(host, "Provider", providerName(wiz.providerId));
  summaryRow(host, "Wire format", draft.kind);
  summaryRow(host, "Base URL", draft.baseUrl || "(missing)");
  summaryRow(host, "Model", draft.model || "(missing)");
  summaryRow(
    host,
    "API key",
    !draft.apiKey
      ? "none - not needed for this provider"
      : PLACEHOLDER_KEY.test(draft.apiKey)
        ? `from the environment: ${draft.apiKey}`
        : `pasted (${draft.apiKey.length} characters)`,
  );
  $("wiz-test-result").hidden = true;
}

/** The provider object as it would be written to the config. */
function wizardDraft() {
  return {
    kind: wiz.kind || "openai",
    baseUrl: (wiz.baseUrl || "").trim(),
    apiKey: wiz.apiKey || "",
    model: (wiz.model || "").trim(),
    maxTokens: 8192,
  };
}

async function wizardTest() {
  const out = $("wiz-test-result");
  const problem = validateStep(3);
  if (problem) return testResult(out, { ok: false, error: problem });
  const btn = $("btn-wiz-test");
  btn.disabled = true;
  testPending(out, "Sending one token to the provider\u2026");
  try {
    const draft = wizardDraft();
    const res = await api("/api/providers/test", {
      method: "POST",
      body: { provider: draft, model: draft.model },
    });
    testResult(out, res);
  } catch (err) {
    if (err.message === "Unauthorized") out.hidden = true;
    else testResult(out, { ok: false, error: err.message });
  } finally {
    btn.disabled = false;
  }
}

async function wizardFinish() {
  const draft = wizardDraft();
  const body = { id: wiz.providerId, kind: draft.kind, baseUrl: draft.baseUrl, model: draft.model };
  if (draft.apiKey) body.apiKey = draft.apiKey;
  const label = wiz.label || (wiz.providerId === "other" ? "custom" : "");
  if (label) body.label = label;

  const next = $("btn-wiz-next");
  next.disabled = true;
  wizStatus("Saving\u2026");
  try {
    const res = await api("/api/providers", { method: "POST", body });
    const target = wiz.returnTo;
    wiz = null;
    await refreshState();
    if (settingsLoaded) await loadSettings(false);
    exitWizard(target);
    toast(t("ui.providerReady", { id: (res && res.id) || body.id }));
  } catch (err) {
    if (err.message !== "Unauthorized") wizStatus(err.message, true);
  } finally {
    next.disabled = false;
  }
}

/* --------------------------------------------------------------------- tabs */

/** Exactly one of chat / settings / wizard is on screen. */
/**
 * The tabs, driven by a table rather than by a chain of ifs.
 *
 * switchTab used to be binary - anything that was not "chat" resolved to
 * settings - so adding a third tab meant rewriting both functions. Now a new tab
 * is a new row here.
 */
const TABS = [
  { name: "chat", tab: "tab-chat", panel: "panel-chat" },
  { name: "power", tab: "tab-power", panel: "panel-power" },
  { name: "settings", tab: "tab-settings", panel: "panel-settings" },
];

/** Exactly one panel on screen. The wizard is not a tab: it takes the whole view. */
function showView(name) {
  const wizard = name === "wizard";
  for (const { name: n, panel } of TABS) $(panel).hidden = wizard || n !== name;
  $("panel-wizard").hidden = !wizard;
  $("tabbar").hidden = wizard; // the wizard is full screen on purpose
}

function switchTab(name) {
  const target = TABS.some((x) => x.name === name) ? name : "chat";
  showView(target);
  for (const { name: n, tab } of TABS) {
    const on = n === target;
    const b = $(tab);
    b.setAttribute("aria-selected", String(on));
    b.tabIndex = on ? 0 : -1;
    b.classList.toggle("active", on);
  }
  if (target === "chat") scrollToBottom(true);
  else if (target === "power") loadPower().catch(fail);
  else if (!settingsLoaded) loadSettings(false).catch(fail);
}

/* -------------------------------------------------------------------- power */

/**
 * The Power panel: what the agent could do on this device and what is missing.
 * Everything comes from GET /api/capabilities; this file decides only how it
 * looks. The full design (one-tap install, the privilege wizard) lands next; for
 * now it lists the same data the terminal `tca power` prints.
 */
async function loadPower() {
  const host = $("power-body");
  host.textContent = "";
  host.appendChild(el("p", "muted small", t("ui.checking")));
  try {
    powerData = await api(`/api/capabilities?lang=${encodeURIComponent(lang)}`);
  } catch (err) {
    powerData = null;
    host.textContent = "";
    host.appendChild(el("p", "warn small", err.message));
    return;
  }
  renderPower(powerData);
}

/**
 * The Power panel.
 *
 * It is not a package store. install.sh already installed everything cheap and
 * useful, so the foundation group is a health line rather than a row of buttons -
 * it only becomes actionable when something is genuinely missing, and then it is a
 * repair, not a choice. Android privileges are handled by `tca serve` at startup
 * and shown here read-only, because pairing ADB happens in the Android settings
 * app and a wizard in the browser could only ever be a worse copy of the terminal
 * flow. What is left is the short list of things only the user can do, and the
 * heavy optional extras, folded away.
 */
function renderPower(data) {
  const host = $("power-body");
  host.textContent = "";
  if (!data) return;

  host.appendChild(scoreCard(data.score));
  if (data.termux && data.privilege) host.appendChild(privilegeStatus(data.privilege));

  const byTier = new Map(data.groups.map((g) => [g.tier, g]));
  // Order matters: what needs you first, then whether the foundation is intact,
  // then the things that are nobody's problem until you want them.
  for (const tier of ["device", "core", "optional"]) {
    const group = byTier.get(tier);
    if (group) host.appendChild(capabilityGroup(group));
  }
  for (const group of data.groups) {
    if (!["device", "core", "optional"].includes(group.tier)) host.appendChild(capabilityGroup(group));
  }

  if (!data.termux) host.appendChild(el("p", "muted small", t("ui.notTermux")));
}

function scoreCard(score) {
  const head = el("section", "power-score");
  head.append(el("p", "power-score-label", t("status.score")), el("p", "power-score-value", `${score.percent}%`));
  const bar = el("div", "power-bar");
  bar.setAttribute("role", "img");
  bar.setAttribute("aria-label", `${t("status.score")}: ${score.percent}%`);
  const fill = el("span", "power-bar-fill");
  fill.style.width = `${score.percent}%`;
  bar.appendChild(fill);
  head.appendChild(bar);
  return head;
}

/**
 * Privileges, read-only.
 *
 * Deliberately not a wizard. Granting ADB means leaving the browser for the
 * Android settings app and reading a pairing code off it; `tca adb-setup` in the
 * terminal does that better, and `tca serve` retries in the background so the
 * moment you grant it from anywhere, it applies itself. All this needs to do is
 * say whether it worked.
 */
function privilegeStatus(priv) {
  const section = el("section", "power-group power-priv");
  section.appendChild(el("h2", "power-group-title", t("power.privSection")));

  const card = el("article", `power-item ${priv.kind ? "good" : "bad"}`);
  card.append(el("p", "power-item-title", priv.label), el("p", "power-item-why muted small", priv.detail));
  if (priv.phantomLabel) card.appendChild(el("p", "power-item-meta muted small", priv.phantomLabel));
  if (!priv.kind) {
    card.append(
      el("p", "power-item-why muted small", t("cap.privilege.why")),
      el("p", "power-item-fix small", "tca adb-setup"),
      el("p", "muted small", t("priv.handledByCli")),
    );
  } else if (priv.kind === "adb") {
    card.appendChild(el("p", "muted small", t("power.rebootWarn")));
  }
  section.appendChild(card);
  return section;
}

function capabilityGroup(group) {
  const missing = group.items.filter((i) => i.ok === false);
  const fine = group.items.filter((i) => i.ok !== false);

  const section = el("section", "power-group");
  section.append(el("h2", "power-group-title", group.title), el("p", "muted small", group.hint));

  // The foundation is install.sh's job. Intact, it is one line; broken, it is one
  // button that fixes the lot rather than a row of identical taps.
  if (group.tier === "core") {
    if (!missing.length) {
      const okCard = el("article", "power-item good");
      okCard.append(
        el("p", "power-item-title", `\u2713 ${t("power.coreOk")}`),
        el("p", "power-item-why muted small", t("power.coreOkNote", { n: fine.length })),
      );
      section.append(okCard, foldedList(fine));
      return section;
    }
    const repair = el("article", "power-item bad");
    repair.append(
      el("p", "power-item-title", t("power.repair", { n: missing.length })),
      el("p", "power-item-why muted small", t("power.repairNote", { n: missing.length })),
      el("p", "power-item-meta muted small", missing.map((m) => m.title).join(" \u00b7 ")),
    );
    const installable = missing.filter((m) => m.installable);
    if (installable.length) repair.appendChild(batchButton(installable, t("power.repair", { n: installable.length })));
    for (const item of missing.filter((m) => !m.installable)) {
      repair.appendChild(el("p", "power-item-fix small", `${item.title}: ${item.fix}`));
    }
    section.append(repair, foldedList(fine));
    return section;
  }

  for (const item of missing) section.appendChild(capabilityCard(item));
  if (!missing.length) section.appendChild(el("p", "power-ok-note small", t("power.allGood")));

  // One button for the whole group beats the same tap five times over.
  const installable = missing.filter((i) => i.installable);
  if (installable.length > 1) section.appendChild(batchButton(installable));

  section.appendChild(foldedList(fine));
  return section;
}

/** Everything already working, as one collapsed line. */
function foldedList(items) {
  if (!items.length) return el("span");
  const done = el("details", "power-done");
  const sum = el("summary");
  sum.append(el("span", "power-done-count", `\u2713 ${items.length}`), el("span", null, t("common.installed")));
  done.appendChild(sum);
  const list = el("ul", "power-done-list");
  for (const item of items) {
    const li = document.createElement("li");
    // ok === null means "cannot be judged here", which is not the same as
    // working; say so rather than implying a tick.
    const mark = item.ok === true ? "\u2713" : "\u2013";
    const state = item.ok === true ? t("common.installed") : t("common.unknown");
    li.className = item.ok === true ? "ok" : "unknown";
    li.append(markGlyph(mark, state));
    li.appendChild(document.createTextNode(item.detail ? `${item.title} \u2014 ${item.detail}` : item.title));
    // Half of "start on boot" is an app we cannot see from inside Termux, so a
    // tick here would be overstating what was actually verified. It is also the
    // one folded item worth being able to switch back off from here.
    if (item.id === "boot" && item.ok === true) {
      li.appendChild(el("span", "power-caveat", t("boot.appNote")));
      li.appendChild(
        actionButton(t("boot.remove"), "btn link power-undo", async () => {
          await api("/api/privilege/boot-script", { method: "POST", body: { remove: true } });
          toast(t("boot.removed"));
          await loadPower();
        }),
      );
    }
    list.appendChild(li);
  }
  done.appendChild(list);
  return done;
}

/** A glyph that carries its meaning as text for a screen reader, not as colour. */
function markGlyph(glyph, label) {
  const span = el("span", "mark", glyph);
  span.setAttribute("role", "img");
  span.setAttribute("aria-label", label);
  return span;
}

/** A button that disables itself while its work runs, and reports a failure. */
function actionButton(label, cls, onClick) {
  const btn = el("button", cls, label);
  btn.type = "button";
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    try {
      await onClick();
    } catch (err) {
      fail(err);
    }
    btn.disabled = false;
  });
  return btn;
}

/** One missing capability, with an install button when there is a package for it. */
function capabilityCard(item) {
  const card = el("article", "power-item bad");
  card.setAttribute("role", "group");
  card.setAttribute("aria-label", `${item.title} \u2014 ${t("common.missing")}`);
  card.append(el("p", "power-item-title", item.title), el("p", "power-item-why muted small", item.why));

  const meta = [
    item.packages.length ? t("common.package", { name: item.packages.join(" ") }) : "",
    item.sizeMb ? t("common.size", { n: item.sizeMb }) : "",
  ].filter(Boolean).join(" \u00b7 ");
  if (meta) card.appendChild(el("p", "power-item-meta muted small", meta));

  if (item.id === "boot") {
    card.appendChild(el("p", "power-item-fix small", item.fix));
    card.appendChild(
      actionButton(t("boot.install"), "btn primary block", async () => {
        await api("/api/privilege/boot-script", { method: "POST", body: {} });
        toast(t("boot.installed"));
        await loadPower();
      }),
    );
    return card;
  }
  // `privilege` has its own section above; the rest are steps to follow by hand.
  if (!item.installable) {
    if (item.id !== "privilege") card.appendChild(el("p", "power-item-fix small", item.fix));
    return card;
  }

  card.appendChild(batchButton([item], t("common.install")));
  return card;
}

/* ------------------------------------------------- installing, with progress */

/** True while an install is streaming, so a second tap cannot start another. */
let installing = false;

/**
 * A button that installs a whole list in one go.
 *
 * Total size goes in the label and anything large is confirmed first: 400 MB over
 * mobile data is not something to discover afterwards.
 */
function batchButton(items, label) {
  const mb = items.reduce((n, i) => n + (i.sizeMb || 0), 0);
  const text = label || t("power.installAll", { n: items.length, mb });
  const btn = el("button", "btn primary block", text);
  btn.type = "button";
  btn.addEventListener("click", () => {
    if (installing) return toast(t("power.busy"), "warn");
    if (mb >= 50 && !confirm(t("power.confirmSize", { mb }))) return;
    runInstall(items, btn);
  });
  return btn;
}

/**
 * Stream an install and show what it is doing.
 *
 * apt takes tens of seconds to minutes on a phone. The server sends
 * newline-delimited JSON as it goes, so this can show which item, which phase, and
 * the last line of output - instead of a frozen spinner, which looks exactly like
 * a hang.
 */
async function runInstall(items, btn) {
  installing = true;
  const card = installProgressCard(items);
  btn.replaceWith(card);

  try {
    const res = await fetch("/api/capabilities/install", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ ids: items.map((i) => i.id) }),
    });
    if (res.status === 409) throw new Error(t("power.busy"));
    if (!res.ok || !res.body) throw new Error(`install failed (${res.status})`);

    // NDJSON: one event per line, and a line can arrive split across chunks.
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          card.onEvent(JSON.parse(line));
        } catch {
          // A malformed line is not worth losing the rest of the stream over.
        }
      }
    }
  } catch (err) {
    card.onEvent({ type: "done", ok: false, error: err.message });
  } finally {
    installing = false;
  }
}

/**
 * The progress card. Returns the element with an onEvent hook attached, so the
 * streaming loop stays about reading and this stays about showing.
 */
function installProgressCard(items) {
  const card = el("article", "power-item install-progress");
  card.setAttribute("role", "status");
  card.setAttribute("aria-live", "polite");

  const title = el("p", "power-item-title", t("power.progressTitle"));
  const which = el("p", "install-which", t("power.progressItem", { n: 1, total: items.length, title: items[0].title }));
  const phase = el("p", "install-phase muted small", t("power.phase.start"));
  const bar = el("div", "power-bar");
  const fill = el("span", "power-bar-fill");
  fill.style.width = "0%";
  bar.appendChild(fill);
  const lastLine = el("p", "install-log-line mono");
  const log = el("details", "power-log");
  log.appendChild(el("summary", null, t("power.installLog")));
  const logPre = pre("");
  log.appendChild(logPre);

  card.append(title, which, bar, phase, lastLine, log);

  const lines = [];
  let finished = 0;
  card.onEvent = (ev) => {
    if (ev.type === "start") {
      const item = items.find((i) => i.id === ev.id);
      which.textContent = t("power.progressItem", {
        n: ev.index + 1,
        total: ev.total,
        title: item ? item.title : ev.id,
      });
      phase.textContent = t("power.phase.start");
    } else if (ev.type === "log") {
      lines.push(ev.line);
      lastLine.textContent = ev.line;
      if (ev.phase) phase.textContent = t(`power.phase.${ev.phase}`);
      // Keep the tail only: the full apt log of a big install is megabytes.
      if (lines.length > 400) lines.splice(0, lines.length - 400);
      logPre.textContent = lines.join("\n");
    } else if (ev.type === "item_done") {
      finished = ev.index + 1;
      fill.style.width = `${Math.round((finished / ev.total) * 100)}%`;
    } else if (ev.type === "done") {
      fill.style.width = "100%";
      lastLine.textContent = "";
      if (ev.ok) {
        card.classList.add("good");
        title.textContent = t("power.installedN", { n: (ev.installed || []).length });
        phase.textContent = "";
        toast(t("power.installedN", { n: (ev.installed || []).length }));
      } else {
        card.classList.add("bad");
        const stuck = items.find((i) => (ev.failed || []).includes(i.id));
        title.textContent = t("power.installFailed");
        phase.textContent = ev.error || (stuck ? t("power.failedAt", { title: stuck.title }) : "");
        log.open = true;
      }
      // Repaint from the payload the server already computed; no extra request.
      if (ev.capabilities) {
        powerData = ev.capabilities;
        setTimeout(() => renderPower(powerData), ev.ok ? 900 : 4000);
      } else {
        setTimeout(() => loadPower().catch(() => {}), 900);
      }
    }
  };
  return card;
}


/* ------------------------------------------------------------- state / boot */

/**
 * Flip between build and plan.
 *
 * Persisted so it survives a reload - a user who put the agent in plan mode
 * because it is pointed at something they care about must not find it back in
 * build mode after Android killed the tab.
 * @param {"build"|"plan"} next
 * @param {boolean} [persist]
 */
function setMode(next, persist = true) {
  mode = next === "plan" ? "plan" : "build";
  const btn = $("btn-mode");
  if (btn) {
    btn.dataset.mode = mode;
    btn.textContent = mode === "plan" ? t("mode.plan") : t("mode.build");
    btn.setAttribute("aria-label", t(mode === "plan" ? "mode.plan.aria" : "mode.build.aria"));
    btn.setAttribute("aria-pressed", String(mode === "plan"));
  }
  document.body.classList.toggle("plan-mode", mode === "plan");
  if (persist) api("/api/mode", { method: "POST", body: { mode } }).catch(() => {});
}

async function refreshState() {
  state = await api("/api/state");
  const bits = [state.active, state.model].filter(Boolean).join(" \u00b7 ");
  $("chat-meta").textContent = state.workspace ? `${bits} \u2014 ${state.workspace}` : bits;
  const warn = $("provider-warning");
  warn.hidden = Boolean(state.providerReady);
  warn.textContent = state.providerReady ? "" : t("chat.noKey");
  $("cfg-path").textContent = state.configPath || "unknown";
  $("version-line").textContent = `tca ${state.version || ""}`.trim();
  if (state.contextWindow && !meter.window) meter.window = state.contextWindow;
  setMode(state.mode === "plan" ? "plan" : "build", false);
  renderMeter();

  // Shared storage is world-readable to any app with "All files access".
  const shared = $("shared-storage-note");
  shared.hidden = !state.configInSharedStorage;
  shared.textContent = state.configInSharedStorage ? t("settings.sharedWarning") : "";

  renderCatalogInfo();
  return state;
}

async function boot() {
  $("token-gate").hidden = true;
  $("app").hidden = false;
  try {
    const s = await refreshState();
    sessions = s.sessions || [];
    if (!sessions.length) {
      await api("/api/sessions", { method: "POST" });
      await loadSessions();
    } else fillSessionSelect();
    const want = store.get(SESSION_KEY);
    await selectSession(sessions.some((x) => x.id === want) ? want : sessions[0].id);
    // Nothing configured yet: a beginner gets the wizard, not an empty composer
    // wired to a provider that can only fail.
    if (!s.providerCount || !s.providerReady) await enterWizard({ returnTo: "chat" });
  } catch (err) {
    fail(err);
  }
}

/* ------------------------------------------------------------------- wiring */

function wire() {
  // ---- token gate
  $("token-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const value = $("token-input").value.trim();
    if (!value) return;
    token = value;
    store.set(TOKEN_KEY, token);
    boot();
  });

  // ---- chat header
  $("session-select").addEventListener("change", (e) => selectSession(e.target.value).catch(fail));
  $("btn-new-session").addEventListener("click", () => newSession().catch(fail));
  $("btn-delete-session").addEventListener("click", () => deleteSession().catch(fail));

  // ---- auto-scroll only while the user is parked at the bottom
  messagesEl().addEventListener("scroll", () => {
    const m = messagesEl();
    const atBottom = m.scrollHeight - m.scrollTop - m.clientHeight < 80;
    stick = atBottom;
    $("jump-latest").hidden = atBottom;
  }, { passive: true });
  $("jump-latest").addEventListener("click", () => scrollToBottom(true));

  // ---- composer
  const ta = $("composer-input");
  ta.addEventListener("input", autogrow);
  ta.addEventListener("keydown", (e) => {
    // Enter stays a newline on purpose (phone keyboard); desktop gets a shortcut.
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send(); }
  });
  $("composer").addEventListener("submit", (e) => { e.preventDefault(); send(); });
  $("btn-stop").addEventListener("click", abort);
  $("btn-mode").addEventListener("click", () => setMode(mode === "plan" ? "build" : "plan"));

  // ---- settings
  $("settings-form").addEventListener("submit", (e) => { e.preventDefault(); saveSettings(); });
  $("active-provider").addEventListener("change", (e) => {
    readProvider();
    provId = e.target.value;
    fillProvider();
  });
  // Typing means the user wants this literal value, not the kept one.
  $("prov-apikey").addEventListener("input", (e) => delete e.target.dataset.keep);
  $("btn-toggle-key").addEventListener("click", () => {
    setKeyVisible($("btn-toggle-key").getAttribute("aria-pressed") !== "true");
  });
  $("btn-add-provider").addEventListener("click", addProvider);
  $("btn-remove-provider").addEventListener("click", removeProvider);
  $("btn-save-model-id").addEventListener("click", saveCurrentModelId);
  $("btn-reload-config").addEventListener("click", () => loadSettings(true).catch(fail));

  // ---- language. Both tables are already loaded, so this is instant.
  $("cfg-lang").addEventListener("change", (e) => setLang(e.target.value));

  // ---- settings: model picker / catalog
  $("model-picker").addEventListener("change", (e) => {
    if (!e.target.value) return;
    $("prov-model").value = e.target.value;
    $("provider-test-result").hidden = true;
  });
  $("prov-model").addEventListener("input", () => {
    const sel = $("model-picker");
    const typed = $("prov-model").value.trim();
    sel.value = modelChoices.some((m) => m.id === typed) ? typed : "";
  });
  $("btn-test-provider").addEventListener("click", () => testActiveProvider());
  $("btn-refresh-live").addEventListener("click", () => refreshLiveModels());
  $("btn-download-catalog").addEventListener("click", () => downloadCatalog());
  $("model-search").addEventListener("input", (e) => scheduleModelSearch(e.target.value));

  // ---- wizard
  $("btn-show-all-providers").addEventListener("click", () => {
    const btn = $("btn-show-all-providers");
    const show = btn.getAttribute("aria-expanded") !== "true";
    $("wiz-all").hidden = !show;
    btn.setAttribute("aria-expanded", String(show));
    btn.textContent = show ? "Hide the full provider list" : "Show all providers";
    if (show) markChosenCard();
  });
  $("wiz-apikey").addEventListener("input", (e) => {
    if (!wiz) return;
    wiz.apiKey = e.target.value.trim();
    checkKeyPrefix();
  });
  $("btn-wiz-toggle-key").addEventListener("click", () => {
    setWizKeyVisible($("btn-wiz-toggle-key").getAttribute("aria-pressed") !== "true");
  });
  $("wiz-baseurl").addEventListener("input", () => { if (wiz) readOtherFields(); });
  $("wiz-label").addEventListener("input", () => { if (wiz) readOtherFields(); });
  $("wiz-kind").addEventListener("change", () => { if (wiz) readOtherFields(); });
  $("wiz-local-baseurl").addEventListener("input", (e) => {
    if (wiz) wiz.baseUrl = e.target.value.trim();
  });
  $("btn-wiz-live").addEventListener("click", () => loadWizardModels("live").catch(() => {}));
  $("wiz-model-select").addEventListener("change", (e) => {
    if (!wiz || !e.target.value) return;
    wiz.model = e.target.value;
    $("wiz-model").value = wiz.model;
    wizStatus("");
  });
  $("wiz-model").addEventListener("input", (e) => {
    if (!wiz) return;
    wiz.model = e.target.value.trim();
    const sel = $("wiz-model-select");
    if (sel.value && sel.value !== wiz.model) sel.value = "";
    wizStatus("");
  });
  $("btn-wiz-test").addEventListener("click", () => { if (wiz) wizardTest(); });
  $("btn-wiz-back").addEventListener("click", () => { if (wiz) goRelative(-1); });
  $("btn-wiz-next").addEventListener("click", () => { if (wiz) goRelative(1); });
  $("btn-wiz-skip").addEventListener("click", () => exitWizard("settings"));

  // ---- tabs (tap, plus left/right arrows for keyboards)
  $("tab-chat").addEventListener("click", () => switchTab("chat"));
  $("tab-power").addEventListener("click", () => switchTab("power"));
  $("tab-settings").addEventListener("click", () => switchTab("settings"));
  $("btn-recheck-power").addEventListener("click", () => loadPower().catch(fail));
  for (const [i, entry] of TABS.entries()) {
    $(entry.tab).addEventListener("keydown", (e) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      e.preventDefault();
      // Wraps around, so the arrow keys never dead-end on the first or last tab.
      const step = e.key === "ArrowRight" ? 1 : -1;
      const next = TABS[(i + step + TABS.length) % TABS.length];
      $(next.tab).focus();
      switchTab(next.name);
    });
  }

  // Track the visual viewport so the Android keyboard shrinks the app instead of
  // covering the composer (belt and braces with dvh + interactive-widget).
  const vv = window.visualViewport;
  if (vv) {
    const sync = () => {
      document.documentElement.style.setProperty("--vvh", `${Math.round(vv.height)}px`);
      document.body.classList.add("has-vvh");
      autogrow();
    };
    vv.addEventListener("resize", sync);
    sync();
  }

  // Android doze kills idle sockets: re-check as soon as we are visible again.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible" || !sessionId || !token) return;
    if (!stream || stream.readyState === EventSource.CLOSED) openStream(sessionId);
    refreshState().catch(() => {});
  });
}

/* --------------------------------------------------------------------- main */

// The dictionary has to be in hand before anything is drawn, otherwise the token
// gate flashes in the wrong language. It is a local request and it never throws:
// if it fails the English already in index.html stands.
(async () => {
  await loadI18n();
  wire();
  applyI18n(document);
  token = takeTokenFromUrl();
  if (token) store.set(TOKEN_KEY, token);
  else token = store.get(TOKEN_KEY);
  if (token) boot();
  else showGate("");
})();
