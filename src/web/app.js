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
    node.textContent = res.model ? `Connection OK \u2014 ${res.model} answered.` : "Connection OK.";
    return true;
  }
  node.className = "test-result bad";
  node.textContent = String((res && res.error) || "Test failed.");
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
  showGate("That token was rejected. Paste the current one.");
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
    try {
      const j = await res.json();
      if (j && (j.error || j.message)) msg = String(j.error || j.message);
    } catch {}
    throw new Error(msg);
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
  const btn = el("button", "btn small", "Copy");
  btn.type = "button";
  btn.setAttribute("aria-label", "Copy code block");
  btn.addEventListener("click", async () => {
    const ok = await copyText(code);
    btn.textContent = ok ? "Copied" : "Failed";
    setTimeout(() => (btn.textContent = "Copy"), 1200);
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
const BUSY = "Working\u2026";

let state = null; // last /api/state payload
let sessions = [];
let sessionId = null;
let streaming = false;
let stream = null; // EventSource, one per selected session
let turn = null; // { bubble, body, text:{node,raw}|null, footer, tools:Map }
let stick = true; // auto-scroll only while the user sits at the bottom
/** approval id -> settle(label), so the server can close a card the user ignored. */
const approvals = new Map();

const setStatus = (text) => ($("stream-status").textContent = text || "");

function setStreaming(on) {
  streaming = on;
  $("btn-send").disabled = on;
  $("btn-stop").hidden = !on;
  $("activity").hidden = !on;
  setStatus(on ? BUSY : "");
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
  bubble.setAttribute("aria-label", role === "user" ? "You" : "Assistant");
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
  body.append(el("p", "tool-label", "input"), pre(prettyInput(input)));
  const row = el("details", "tool");
  row.append(sum, body);
  container.appendChild(row);
  return { row, badge, body };
}

function finishToolRow(handle, ok, output) {
  handle.badge.textContent = ok ? "ok" : "error";
  handle.badge.classList.add(ok ? "ok" : "bad");
  if (!ok) handle.row.classList.add("bad");
  handle.body.append(el("p", "tool-label", "output"), outputBlock(output));
  // A file change is the interesting part of a turn: show the diff without a tap.
  if (ok && looksLikeDiff(output)) handle.row.open = true;
}

/** Inline approval card with Allow / Deny, posted to /api/approvals/:id. */
function approvalCard(ev) {
  const isEdit = ev.kind === "edit";
  const card = el("section", "approval");
  card.setAttribute("role", "group");
  card.setAttribute("aria-label", isEdit ? "File change approval request" : "Command approval request");
  card.tabIndex = -1;
  card.append(
    el("p", "approval-title", isEdit ? "Allow this file change?" : "Run this command?"),
    pre(ev.command ?? ""),
  );
  if (ev.reason) card.appendChild(el("p", "small", String(ev.reason)));
  if (ev.cwd) card.appendChild(el("p", "muted small", `${isEdit ? "workspace" : "cwd"}: ${ev.cwd}`));

  const allow = el("button", "btn primary grow", "Allow");
  const deny = el("button", "btn danger grow", "Deny");
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
      settle(approved ? "Allowed" : "Denied");
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
  toast(isEdit ? "Approval required to change a file" : "Approval required to run a command", "warn");
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
  es.addEventListener("open", () => setStatus(streaming ? BUSY : ""));
  es.addEventListener("message", (e) => {
    let data;
    try { data = JSON.parse(e.data); } catch { return; }
    handleEvent(data);
  });
  es.addEventListener("error", async () => {
    if (es !== stream) return; // stale stream from a previous session
    if (es.readyState === EventSource.CONNECTING) {
      // Routine on mobile (doze, network switch): the browser retries itself.
      setStatus("Connection lost \u2013 reconnecting\u2026");
      return;
    }
    setStatus("Disconnected \u2013 reload to reconnect.");
    try { await api("/api/state"); } catch {} // surfaces a 401 as the token gate
  });
}

function handleEvent(ev) {
  if (!ev || typeof ev.type !== "string") return;
  if (streaming) setStatus(BUSY); // any event means we are connected again
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
      if (settle) settle(ev.outcome === "timeout" ? "Timed out \u2014 not run" : "Cancelled");
      break;
    }
    case "tool_note":
      noteLine(ev.text || "");
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
      footerOf(ensureTurn()).textContent = `${ev.input ?? 0} in \u00b7 ${ev.output ?? 0} out tokens`;
      break;
    case "done": {
      const odd = ev.stopReason && !["end_turn", "stop", "done"].includes(ev.stopReason);
      if (turn && odd) {
        const f = footerOf(turn);
        f.textContent = `${f.textContent ? `${f.textContent} \u00b7 ` : ""}stopped: ${ev.stopReason}`;
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
  const title = (s.title || "").trim() || `Session ${String(s.id).slice(0, 8)}`;
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
  dirtyBlocks.clear();
  approvals.clear();
  setStreaming(false);
  messagesEl().textContent = "";
  const data = await api(`/api/sessions/${encodeURIComponent(id)}`);
  const messages = (data && data.messages) || [];
  for (const m of messages) renderStoredMessage(m);
  if (!messages.length) {
    messagesEl().appendChild(el("p", "empty muted", "No messages yet. Describe what you want changed."));
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
  if (!confirm(`Delete "${label}"? This cannot be undone.`)) return;
  closeStream();
  await api(`/api/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE" });
  sessionId = null;
  await loadSessions();
  if (!sessions.length) await newSession();
  else await selectSession(sessions[0].id);
  toast("Session deleted");
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
    setStatus("Stopping\u2026");
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
  btn.textContent = show ? "Hide" : "Show";
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
    host.appendChild(el("p", "muted small", "No saved model ids yet for this provider."));
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
      toast("Removed \u2013 remember to save");
    });
    chip.append(btn, rm);
    host.appendChild(chip);
  }
}

function saveCurrentModelId() {
  const id = $("prov-model").value.trim();
  if (!id) return toast("Type or pick a model id first", "error");
  const p = (cfg.providers && cfg.providers[provId]) || {};
  if (!Array.isArray(p.models)) p.models = [];
  if (p.models.includes(id)) return toast(`"${id}" is already saved`);
  p.models.push(id);
  renderSavedModelIds();
  toast("Saved \u2013 remember to press \u201cSave settings\u201d");
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
  const source = info.source === "full" ? "full catalog from models.dev" : "bundled offline list (seed)";
  line.textContent =
    `Catalog: ${source} \u00b7 ${info.modelCount} tool-capable models \u00b7 ` +
    `${info.providerCount} providers \u00b7 generated ${info.generated}`;
  btn.textContent = info.source === "full"
    ? "Re-download full catalog (3.8 MB)"
    : "Download full catalog (3.8 MB)";
}

async function downloadCatalog() {
  const btn = $("btn-download-catalog");
  if (!confirm("Download the full model catalog from models.dev?\n\nThat is about 3.8 MB - it will use mobile data if you are not on Wi-Fi.")) {
    return;
  }
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Downloading\u2026";
  try {
    const res = await api("/api/catalog/download", { method: "POST" });
    if (res && res.catalog && state) state.catalog = res.catalog;
    providersInfo = null; // provider list is cheap; re-fetch with fresh counts
    renderCatalogInfo();
    await fillModelPicker();
    toast(`Catalog updated: ${res.models} models from ${res.providers} providers`);
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
  testPending(out, "Testing\u2026");
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
  host.appendChild(el("p", "muted small", "Searching\u2026"));
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
    host.appendChild(el("p", "muted small", "Nothing matched. Try a shorter word."));
    return;
  }
  for (const hit of hits) {
    const btn = el("button", `hit${hit.known ? "" : " unknown"}`);
    btn.type = "button";
    btn.append(el("span", "hit-title", `${hit.providerName} \u2014 ${hit.model.name || hit.model.id}`));
    const meta = [hit.model.id, fmtContext(hit.model.context), fmtPrice(hit.model)].filter(Boolean).join(" \u00b7 ");
    btn.append(el("span", "hit-meta", meta));
    if (!hit.known) btn.append(el("span", "hit-warn", "needs a manual base URL"));
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
    toast(`${hit.providerName}: ${hit.model.id} \u2013 remember to save`);
    return;
  }
  // Known provider, not configured yet: the wizard collects key + base URL.
  toast(`${hit.providerName} is not set up yet \u2013 finishing setup for it`);
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
  cfg.maxSteps = Number($("cfg-maxsteps").value) || 40;
  cfg.instructions = $("cfg-instructions").value;
  cfg.denyCommands = $("cfg-deny").value.split("\n").map((s) => s.trim()).filter(Boolean);
}

async function loadSettings(announce) {
  cfg = await api("/api/config");
  if (!cfg.providers) cfg.providers = {};
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
  loadAndroidStatus().catch(() => {});
  if (announce) toast("Config reloaded from disk");
}

/** Same checks as `tca doctor`, rendered as a list in Settings. */
async function loadAndroidStatus() {
  const host = $("status-list");
  host.textContent = "";
  host.appendChild(el("p", "muted small", "Checking\u2026"));
  let res;
  try {
    res = await api("/api/status");
  } catch (err) {
    host.textContent = "";
    host.appendChild(el("p", "warn small", err.message));
    return;
  }
  host.textContent = "";
  if (!res.termux) {
    host.appendChild(el("p", "muted small", "Not running under Termux \u2013 Android-only checks are skipped."));
  }
  for (const c of res.checks) {
    const row = el("div", "status-row");
    const mark = c.ok === null ? "status-dot neutral" : c.ok ? "status-dot ok" : "status-dot bad";
    row.appendChild(el("span", mark));
    const body = el("div", "status-body");
    body.appendChild(el("p", "status-label", c.label));
    if (c.ok === false && c.fix) body.appendChild(el("p", "status-fix muted small", c.fix));
    row.appendChild(body);
    host.appendChild(row);
  }
}

async function saveSettings() {
  readSettings();
  try {
    const res = await api("/api/config", { method: "PUT", body: cfg });
    toast(`Saved to ${res && res.path ? res.path : "config"}`);
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
  toast("Removed \u2013 press \u201cSave settings\u201d to make it permanent");
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
  if (!recs.length) host.appendChild(el("p", "muted small", "No recommendations returned by the server."));
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
    const a = el("a", "keylink", "Get an API key");
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
  btn.textContent = show ? "Hide" : "Show";
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
    toast(`Provider "${res && res.id ? res.id : body.id}" is ready`);
  } catch (err) {
    if (err.message !== "Unauthorized") wizStatus(err.message, true);
  } finally {
    next.disabled = false;
  }
}

/* --------------------------------------------------------------------- tabs */

/** Exactly one of chat / settings / wizard is on screen. */
function showView(name) {
  $("panel-chat").hidden = name !== "chat";
  $("panel-settings").hidden = name !== "settings";
  $("panel-wizard").hidden = name !== "wizard";
  $("tabbar").hidden = name === "wizard"; // the wizard is full screen on purpose
}

function switchTab(name) {
  const isChat = name === "chat";
  showView(isChat ? "chat" : "settings");
  for (const [id, on] of [["tab-chat", isChat], ["tab-settings", !isChat]]) {
    const b = $(id);
    b.setAttribute("aria-selected", String(on));
    b.tabIndex = on ? 0 : -1;
    b.classList.toggle("active", on);
  }
  if (isChat) scrollToBottom(true);
  else if (!settingsLoaded) loadSettings(false).catch(fail);
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
  $("btn-recheck-status").addEventListener("click", () => loadAndroidStatus().catch(fail));

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
  $("tab-settings").addEventListener("click", () => switchTab("settings"));
  for (const id of ["tab-chat", "tab-settings"]) {
    $(id).addEventListener("keydown", (e) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      e.preventDefault();
      const next = id === "tab-chat" ? "tab-settings" : "tab-chat";
      $(next).focus();
      switchTab(next === "tab-chat" ? "chat" : "settings");
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

wire();
token = takeTokenFromUrl();
if (token) store.set(TOKEN_KEY, token);
else token = store.get(TOKEN_KEY);
if (token) boot();
else showGate("");
