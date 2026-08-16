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

/** A <pre><code> block with a Copy button. `tabIndex` lets keyboards scroll it. */
function codeBlock(code, lang) {
  const head = el("div", "code-head");
  const btn = el("button", "btn small", t("code.copy"));
  btn.type = "button";
  btn.setAttribute("aria-label", t("code.copyAria"));
  btn.addEventListener("click", async () => {
    const ok = await copyText(code);
    btn.textContent = ok ? t("code.copied") : t("code.copyFailed");
    setTimeout(() => (btn.textContent = t("code.copy")), 1200);
  });
  head.append(el("span", "code-lang", lang || "code"), btn);
  const wrap = el("div", "code");
  wrap.append(head, pre(code));
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

/** Append an empty message bubble and hand back its parts. */
function makeBubble(role) {
  const bubble = el("article", `msg ${role}`);
  bubble.setAttribute("aria-label", role === "user" ? t("chat.you") : t("chat.assistant"));
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
  turn = { bubble, body, text: null, footer: null, tools: new Map() };
  scrollToBottom();
  return turn;
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
  for (const b of dirtyBlocks) renderRich(b.node, b.raw);
  dirtyBlocks.clear();
  scrollToBottom();
}

function appendDelta(text) {
  const t = ensureTurn();
  if (!t.text) {
    const node = el("div", "rich");
    t.body.appendChild(node);
    t.text = { node, raw: "" };
  }
  t.text.raw += String(text);
  scheduleRender(t.text);
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
 */
function noteLine(text) {
  const host = turn ? turn.body : messageHost();
  host.appendChild(el("p", "tool-note", String(text)));
  if (turn) turn.text = null; // later text starts a fresh block, preserving order
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

/** Render one stored message from GET /api/sessions/:id. */
function renderStoredMessage(msg) {
  const role = msg.role === "user" ? "user" : "assistant";
  const { body } = makeBubble(role);
  if (role === "user") {
    body.appendChild(el("div", "prose", String(msg.content ?? "")));
    return;
  }
  const rich = el("div", "rich");
  renderRich(rich, String(msg.content ?? ""));
  body.appendChild(rich);
  for (const call of msg.toolCalls || []) {
    finishToolRow(toolRow(body, call.name, call.input), call.ok !== false, call.output);
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

function handleEvent(ev) {
  if (!ev || typeof ev.type !== "string") return;
  if (streaming) setStatus(BUSY()); // any event means we are connected again
  switch (ev.type) {
    case "text_delta":
      if (!streaming) setStreaming(true); // e.g. page reloaded mid-turn
      appendDelta(ev.text || "");
      break;
    case "tool_start": {
      if (!streaming) setStreaming(true);
      const t = ensureTurn();
      t.tools.set(String(ev.id), toolRow(t.body, ev.name, ev.input));
      t.text = null; // following text starts a new block, keeping stream order
      scrollToBottom();
      break;
    }
    case "tool_end": {
      const t = ensureTurn();
      let handle = t.tools.get(String(ev.id));
      if (!handle) {
        handle = toolRow(t.body, ev.name, ev.input); // tool_start missed
        t.tools.set(String(ev.id), handle);
        t.text = null;
      }
      finishToolRow(handle, ev.ok !== false, ev.output);
      scrollToBottom();
      break;
    }
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
      noteLine(ev.text || "");
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
    case "usage":
      footerOf(ensureTurn()).textContent = t("chat.tokens", { in: ev.input ?? 0, out: ev.output ?? 0 });
      break;
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
  const data = await api(`/api/sessions/${encodeURIComponent(id)}`);
  const messages = (data && data.messages) || [];
  for (const m of messages) renderStoredMessage(m);
  if (!messages.length) {
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
    await api(`/api/sessions/${encodeURIComponent(sessionId)}/message`, { method: "POST", body: { text } });
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

function renderPower(data) {
  const host = $("power-body");
  host.textContent = "";
  if (!data) return;

  host.appendChild(scoreCard(data.score));

  // Privileges first when they are missing: it is the one gap that silently
  // breaks long tasks, so it should not sit below a list of optional packages.
  if (data.termux && data.privilege && !data.privilege.kind) host.appendChild(privilegeSection(data.privilege));

  for (const group of data.groups) host.appendChild(capabilityGroup(group));

  if (data.termux && data.privilege && data.privilege.kind) host.appendChild(privilegeSection(data.privilege));
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

function capabilityGroup(group) {
  const missing = group.items.filter((i) => i.ok === false);
  const fine = group.items.filter((i) => i.ok !== false);

  const section = el("section", "power-group");
  section.append(el("h2", "power-group-title", group.title), el("p", "muted small", group.hint));

  for (const item of missing) section.appendChild(capabilityCard(item));
  if (!missing.length) section.appendChild(el("p", "power-ok-note small", t("power.allGood")));

  // Everything already working folds into one line: the panel must show what
  // needs doing, not a wall of green ticks.
  if (fine.length) {
    const done = el("details", "power-done");
    const sum = el("summary");
    sum.append(el("span", "power-done-count", `\u2713 ${fine.length}`), el("span", null, t("common.installed")));
    done.appendChild(sum);
    const list = el("ul", "power-done-list");
    for (const item of fine) {
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
          privAction(t("boot.remove"), "btn link power-undo", async () => {
            await api("/api/privilege/boot-script", { method: "POST", body: { remove: true } });
            toast(t("boot.removed"));
            await loadPower();
          }),
        );
      }
      list.appendChild(li);
    }
    done.appendChild(list);
    section.appendChild(done);
  }
  return section;
}

/** A glyph that carries its meaning as text for a screen reader, not as colour. */
function markGlyph(glyph, label) {
  const span = el("span", "mark", glyph);
  span.setAttribute("role", "img");
  span.setAttribute("aria-label", label);
  return span;
}

/** One missing capability, with the install button when there is something to install. */
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

  if (!item.installable) {
    // `privilege` has its own section below; `boot` writes a file rather than
    // installing a package; the rest are instructions to follow by hand.
    if (item.id === "boot") {
      card.appendChild(el("p", "power-item-fix small", item.fix));
      card.appendChild(
        privAction(t("boot.install"), "btn primary block", async () => {
          await api("/api/privilege/boot-script", { method: "POST", body: {} });
          toast(t("boot.installed"));
          await loadPower();
        }),
      );
      return card;
    }
    if (item.id !== "privilege") card.appendChild(el("p", "power-item-fix small", item.fix));
    return card;
  }

  const btn = el("button", "btn primary block", t("common.install"));
  btn.type = "button";
  const result = el("p", "power-item-result small");
  result.setAttribute("role", "status");
  result.hidden = true;

  btn.addEventListener("click", async () => {
    btn.disabled = true;
    btn.textContent = t("common.installing");
    result.hidden = true;
    try {
      const res = await api("/api/capabilities/install", { method: "POST", body: { id: item.id } });
      result.textContent = res.ok ? t("power.installed", { title: item.title }) : t("power.installFailed");
      result.className = `power-item-result small ${res.ok ? "ok" : "warn"}`;
      result.hidden = false;
      if (res.output) result.appendChild(installLog(res.output));
      if (res.ok) {
        toast(t("power.installed", { title: item.title }));
        await loadPower(); // the card disappears, which is the confirmation
        return;
      }
    } catch (err) {
      result.textContent = err.message;
      result.className = "power-item-result small warn";
      result.hidden = false;
    }
    btn.disabled = false;
    btn.textContent = t("common.install");
  });

  card.append(btn, result);
  return card;
}

/** apt output, folded away: useful when it fails, noise when it works. */
function installLog(text) {
  const box = el("details", "power-log");
  box.appendChild(el("summary", null, t("power.installLog")));
  box.appendChild(pre(text));
  return box;
}

/* ------------------------------------------------- the privilege sub-wizard */

/** Which sub-view of the privilege section is open: null = the method list. */
let privView = null;

function privilegeSection(priv) {
  const section = el("section", "power-group power-priv");
  section.append(el("h2", "power-group-title", t("power.privSection")));

  const state = el("article", `power-item ${priv.kind ? "good" : "bad"}`);
  state.append(el("p", "power-item-title", priv.label), el("p", "power-item-why muted small", priv.detail));
  if (priv.phantomLabel) state.appendChild(el("p", "power-item-meta muted small", priv.phantomLabel));
  section.appendChild(state);

  if (privView) {
    section.appendChild(privSubView(privView, priv));
    return section;
  }

  // Already working: offer a recheck and nothing else. Re-applying is cheap and
  // is what a user coming back after a reboot actually needs.
  if (priv.kind) {
    section.appendChild(privAction(t("common.recheck"), "btn block", () => privRecheck()));
    if (priv.kind === "adb") section.appendChild(el("p", "muted small", t("power.rebootWarn")));
    return section;
  }

  section.appendChild(el("p", "small", t("power.chooseMethod")));
  const list = el("div", "priv-methods");
  for (const m of [
    { id: "recheck", title: t("priv.method.recheck.title"), desc: t("priv.method.recheck.desc") },
    { id: "pair", title: t("priv.method.pair.title"), desc: t("priv.method.pair.desc") },
    { id: "shizuku", title: t("priv.method.shizuku.title"), desc: t("priv.method.shizuku.desc") },
    { id: "root", title: t("priv.method.root.title"), desc: t("priv.method.root.desc") },
  ]) {
    const card = el("button", "priv-method");
    card.type = "button";
    card.append(el("span", "priv-method-title", m.title), el("span", "priv-method-desc", m.desc));
    card.addEventListener("click", () => {
      if (m.id === "recheck") return privRecheck();
      privView = { name: m.id, step: 1 };
      renderPower(powerData);
    });
    list.appendChild(card);
  }
  section.appendChild(list);
  return section;
}

function privAction(label, cls, onClick) {
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

function privBack() {
  const btn = el("button", "btn link priv-back", t("power.back"));
  btn.type = "button";
  btn.addEventListener("click", () => {
    privView = null;
    renderPower(powerData);
  });
  return btn;
}

/** Report which unlocks landed, per entry, so a vendor that blocks appops is visible. */
function privApplied(applied, ok) {
  const box = el("div", "priv-applied");
  const okCount = applied.filter((a) => a.ok).length;
  box.appendChild(el("p", `small ${ok ? "ok" : "warn"}`, t("power.applied", { ok: okCount, total: applied.length })));
  const list = el("ul", "priv-applied-list");
  for (const a of applied) {
    const li = document.createElement("li");
    li.className = a.ok ? "ok" : "warn";
    li.textContent = `${a.ok ? "\u2713" : "\u2717"} ${t(a.labelKey)}`;
    list.appendChild(li);
  }
  box.append(list, el("p", "muted small", ok ? t("power.appliedAll") : t("power.appliedSome")));
  return box;
}

async function privRecheck() {
  const res = await api("/api/privilege/recheck", { method: "POST" });
  privView = res.kind ? null : privView;
  await loadPower();
  if (res.applied && res.applied.length) {
    $("power-body").appendChild(privApplied(res.applied, res.appliedOk));
  }
  if (!res.kind) toast(t("priv.err.no_backend"), "warn");
}

function privSubView(view, priv) {
  const box = el("div", "priv-flow");
  box.appendChild(privBack());
  if (view.name === "root") return rootFlow(box, priv);
  if (view.name === "shizuku") return shizukuFlow(box, priv);
  return pairFlow(box, priv);
}

function rootFlow(box, priv) {
  box.append(
    el("h3", "priv-flow-title", t("priv.method.root.title")),
    el("p", "muted small", t("priv.method.root.desc")),
  );
  if (priv.root && priv.root.note) box.appendChild(el("p", "muted small mono", priv.root.note));
  box.appendChild(
    privAction(t("priv.root.check"), "btn primary block", async () => {
      const res = await api("/api/privilege/recheck", { method: "POST" });
      if (res.kind) {
        privView = null;
        await loadPower();
        $("power-body").appendChild(privApplied(res.applied, res.appliedOk));
      } else {
        toast(t("priv.err.no_root"), "warn");
        await loadPower();
      }
    }),
  );
  return box;
}

function shizukuFlow(box, priv) {
  box.append(
    el("h3", "priv-flow-title", t("priv.method.shizuku.title")),
    el("p", "muted small", t("priv.method.shizuku.desc")),
  );
  const steps = el("ol", "priv-steps");
  for (const key of ["priv.shizuku.s1", "priv.shizuku.s2", "priv.shizuku.s3", "priv.shizuku.s4"]) {
    const li = document.createElement("li");
    li.textContent = t(key);
    steps.appendChild(li);
  }
  box.appendChild(steps);

  const files = (priv.rish && priv.rish.files) || { script: false, dex: false };
  box.appendChild(
    el("p", "muted small mono", `rish: ${files.script ? "\u2713" : "\u2717"}  rish_shizuku.dex: ${files.dex ? "\u2713" : "\u2717"}`),
  );

  box.appendChild(
    privAction(t("priv.shizuku.copy"), "btn block", async () => {
      try {
        await api("/api/privilege/copy-rish", { method: "POST" });
        toast(t("priv.shizuku.copied"));
      } catch (err) {
        // The server answers with a translation key, which is the useful message.
        toast(err.errKey ? t(err.errKey) : err.message, "warn");
      }
      await loadPower();
    }),
  );
  box.appendChild(
    privAction(t("priv.shizuku.check"), "btn primary block", async () => {
      const res = await api("/api/privilege/recheck", { method: "POST" });
      if (res.kind) {
        privView = null;
        await loadPower();
        $("power-body").appendChild(privApplied(res.applied, res.appliedOk));
      } else {
        toast(t(files.script && files.dex ? "priv.err.rish_dead" : "priv.err.rish_missing"), "warn");
        await loadPower();
      }
    }),
  );
  return box;
}

/**
 * Wireless ADB pairing, three steps. This is the flow the web UI genuinely
 * improves on the terminal: the address and the code can be pasted from the
 * Android settings screen instead of typed digit by digit.
 */
function pairFlow(box, priv) {
  const step = privView.step || 1;
  box.append(
    el("h3", "priv-flow-title", t("priv.method.pair.title")),
    el("p", "priv-step-count muted small", t("power.step", { n: step, total: 3 })),
  );

  if (!priv.adb || !priv.adb.installed) {
    box.append(
      el("p", "small", t("priv.err.no_adb")),
      privAction(t("priv.pair.installAdb"), "btn primary block", async () => {
        await api("/api/privilege/install-adb", { method: "POST" });
        await loadPower();
      }),
    );
    return box;
  }

  if (step === 1) {
    box.append(el("h4", "priv-step-title", t("priv.pair.s1.title")), el("p", "small", t("priv.pair.s1.body")));
    const next = el("button", "btn primary block", t("priv.pair.s1.done"));
    next.type = "button";
    next.addEventListener("click", () => {
      privView = { name: "pair", step: 2 };
      renderPower(powerData);
    });
    box.appendChild(next);
    return box;
  }

  if (step === 2) {
    box.append(el("h4", "priv-step-title", t("priv.pair.s2.title")), el("p", "small", t("priv.pair.s2.body")));
    const addr = privField("priv-pair-addr", t("priv.pair.addrLabel"), "192.168.1.5:38721", "text");
    const code = privField("priv-pair-code", t("priv.pair.codeLabel"), "123456", "text");
    code.input.inputMode = "numeric";
    code.input.maxLength = 6;
    const out = el("p", "priv-flow-result small");
    out.setAttribute("role", "status");
    out.hidden = true;
    box.append(addr.wrap, code.wrap);
    box.appendChild(
      privAction(t("priv.pair.doPair"), "btn primary block", async () => {
        out.hidden = true;
        try {
          await api("/api/privilege/pair", {
            method: "POST",
            body: { address: addr.input.value, code: code.input.value },
          });
          toast(t("priv.pair.paired"));
          privView = { name: "pair", step: 3 };
          renderPower(powerData);
        } catch (err) {
          out.className = "priv-flow-result small warn";
          out.textContent = err.errKey ? t(err.errKey) : err.message;
          out.hidden = false;
        }
      }),
    );
    box.appendChild(out);
    return box;
  }

  box.append(el("h4", "priv-step-title", t("priv.pair.s3.title")), el("p", "small", t("priv.pair.s3.body")));
  const conn = privField("priv-pair-conn", t("priv.pair.connectLabel"), "192.168.1.5:41235", "text");
  const out = el("p", "priv-flow-result small");
  out.setAttribute("role", "status");
  out.hidden = true;
  box.appendChild(conn.wrap);
  box.appendChild(
    privAction(t("priv.pair.doConnect"), "btn primary block", async () => {
      out.hidden = true;
      try {
        const res = await api("/api/privilege/connect", {
          method: "POST",
          body: { address: conn.input.value },
        });
        privView = null;
        await loadPower();
        if (res.applied) $("power-body").appendChild(privApplied(res.applied, res.appliedOk));
      } catch (err) {
        out.className = "priv-flow-result small warn";
        out.textContent = err.errKey ? t(err.errKey) : err.message;
        out.hidden = false;
      }
    }),
  );
  box.appendChild(out);
  box.appendChild(el("p", "muted small", t("power.rebootWarn")));
  return box;
}

/** A labelled input, built here so the flow markup stays in one place. */
function privField(id, label, placeholder, type) {
  const wrap = el("div", "priv-field");
  const lab = el("label", null, label);
  lab.setAttribute("for", id);
  const input = document.createElement("input");
  input.id = id;
  input.type = type;
  input.placeholder = placeholder;
  input.autocapitalize = "off";
  input.autocomplete = "off";
  input.spellcheck = false;
  wrap.append(lab, input);
  return { wrap, input };
}

/* ------------------------------------------------------------- state / boot */

async function refreshState() {
  state = await api("/api/state");
  const bits = [state.active, state.model].filter(Boolean).join(" \u00b7 ");
  $("chat-meta").textContent = state.workspace ? `${bits} \u2014 ${state.workspace}` : bits;
  const warn = $("provider-warning");
  warn.hidden = Boolean(state.providerReady);
  warn.textContent = state.providerReady ? "" : "No usable API key for the active provider. Open Settings.";
  $("cfg-path").textContent = state.configPath || "unknown";
  $("version-line").textContent = `tca ${state.version || ""}`.trim();

  // Shared storage is world-readable to any app with "All files access".
  const shared = $("shared-storage-note");
  shared.hidden = !state.configInSharedStorage;
  shared.textContent = state.configInSharedStorage
    ? "This file is on shared storage, so any app with \u201cAll files access\u201d can read it. " +
      "Write the key as ${VAR_NAME} to read it from the environment instead of storing it here."
    : "";

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
