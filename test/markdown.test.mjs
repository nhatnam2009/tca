/**
 * Markdown renderer tests.
 *
 * src/web/app.js is a classic script written for the browser, so it is loaded
 * here into a deliberately small DOM stub. Two things make that worth the
 * trouble: the renderer is the one place where untrusted model output becomes
 * DOM, and it is pure text -> tree, which is exactly what a test can pin down.
 *
 * The stub has no innerHTML on purpose. If anyone ever reaches for it, these
 * tests fail instead of shipping an XSS hole.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src");
// The same table the daemon serves at /assets/i18n.json, handed to the app below
// through a stubbed fetch, so the real loadI18n() path is what gets tested.
const { DICT } = await import("../src/i18n.js");
// Needed to know which keys the code builds at runtime rather than writing out.
const { CAPABILITIES, TIERS } = await import("../src/capabilities.js");
const { UNLOCKS } = await import("../src/privilege.js");

/* ------------------------------------------------------------------ DOM stub */

class StubNode {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.attrs = {};
    this.className = "";
    this.dataset = {};
    this.classes = new Set();
    this.classList = {
      add: (...c) => c.forEach((x) => this.classes.add(x)),
      remove: (...c) => c.forEach((x) => this.classes.delete(x)),
      contains: (c) => this.classes.has(c),
      toggle: (c, on) => (on ? this.classes.add(c) : this.classes.delete(c)),
    };
    this.style = { setProperty() {}, removeProperty() {} };
  }

  get textContent() {
    return this.children.map((c) => (c.isText ? c.data : c.textContent)).join("");
  }
  set textContent(v) {
    this.children = v === "" || v == null ? [] : [{ isText: true, data: String(v) }];
  }

  appendChild(node) {
    if (node && node.isFragment) {
      for (const c of node.children) this.children.push(c);
      node.children = [];
      return node;
    }
    this.children.push(node);
    return node;
  }
  append(...nodes) {
    for (const n of nodes) this.appendChild(n);
  }
  remove() {}
  setAttribute(k, v) {
    this.attrs[k] = String(v);
  }
  getAttribute(k) {
    return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null;
  }
  addEventListener() {}
  removeEventListener() {}
  focus() {}
  querySelector() {
    return null;
  }
  querySelectorAll() {
    return [];
  }
  get lastElementChild() {
    for (let i = this.children.length - 1; i >= 0; i--) {
      if (this.children[i] && this.children[i].tagName) return this.children[i];
    }
    return null;
  }
  get firstElementChild() {
    return this.children.find((c) => c && c.tagName) || null;
  }
}

function getAllWebJsFiles(dir = path.join(SRC, "web")) {
  let files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...getAllWebJsFiles(full));
    else if (entry.isFile() && entry.name.endsWith(".js")) files.push(full);
  }
  return files;
}

function readAllWebJs() {
  return getAllWebJsFiles().map((f) => fs.readFileSync(f, "utf8")).join("\n");
}

function prepareScript(source) {
  return source
    .replace(/^import\s+[\s\S]*?from\s+["'][^"']+["'];?/gm, "")
    .replace(/^import\s+["'][^"']+["'];?/gm, "")
    .replace(/^export\s+(async\s+)?(const|let|var|function|class)\s+/gm, "$1$2 ")
    .replace(/^export\s*\{[\s\S]*?\};?/gm, "")
    .replace(/^export\s+default\s+/gm, "");
}

/** Load app.js and its modules with just enough globals that its top-level wire() survives. */
function loadApp() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const webDir = path.join(here, "..", "src", "web");

  const moduleFiles = [
    "helpers.js",
    "state.js",
    "api.js",
    "markdown.js",
    "components/statusbar.js",
    "components/sidebar.js",
    "components/todopanel.js",
    "components/toolcard.js",
    "components/approval.js",
    "components/chat.js",
    "components/settings.js",
    "components/wizard.js",
    "app.js",
  ];

  const byId = new Map();
  const document = {
    createElement: (tag) => new StubNode(tag),
    createTextNode: (t) => ({ isText: true, data: String(t) }),
    createDocumentFragment: () => {
      const f = new StubNode("#fragment");
      f.isFragment = true;
      return f;
    },
    getElementById: (id) => {
      if (!byId.has(id)) byId.set(id, new StubNode("div"));
      return byId.get(id);
    },
    // applyI18n() walks these at boot. Empty is correct here: this stub has no
    // markup, and the point of these tests is the renderer, not the labels.
    querySelectorAll: () => [],
    querySelector: () => null,
    addEventListener() {},
    documentElement: new StubNode("html"),
    visibilityState: "visible",
    body: new StubNode("body"),
  };

  class EventSourceStub {
    constructor() {
      this.readyState = 0;
    }
    addEventListener() {}
    close() {}
  }
  EventSourceStub.CONNECTING = 0;
  EventSourceStub.OPEN = 1;
  EventSourceStub.CLOSED = 2;

  const sandbox = {
    document,
    EventSource: EventSourceStub,
    localStorage: {
      getItem: () => null,
      setItem() {},
      removeItem() {},
    },
    location: { href: "http://127.0.0.1:8787/", pathname: "/", hash: "", search: "" },
    history: { replaceState() {} },
    navigator: { clipboard: { writeText: async () => {} }, language: "en" },
    fetch: async (url) => {
      // The one request app.js makes before anything is drawn. Answering it with
      // the real table means loadI18n() itself is under test, not a stand-in.
      if (String(url).includes("i18n.json")) {
        return { ok: true, json: async () => ({ langs: ["vi", "en"], default: "vi", dict: DICT }) };
      }
      throw new Error("no network in tests");
    },
    URL,
    Map,
    Set,
    JSON,
    Number,
    String,
    Boolean,
    Object,
    Array,
    Promise,
    Error,
    RegExp,
    Math,
    Date,
    console,
    setTimeout,
    clearTimeout,
    requestAnimationFrame: () => 0,
    confirm: () => false,
    alert() {},
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;

  vm.createContext(sandbox);
  for (const rel of moduleFiles) {
    const raw = fs.readFileSync(path.join(webDir, rel), "utf8");
    const script = prepareScript(raw);
    vm.runInContext(script, sandbox, { filename: rel });
  }
  return sandbox;
}

const app = loadApp();
// loadI18n() is awaited inside app.js's top-level async block, so give that block
// a turn to finish before any test reads a translated string.
await new Promise((resolve) => setImmediate(resolve));

/** Compact tree dump: "ul[md-list] > li:'a', li:'b'" is easier to assert on. */
function shape(node) {
  if (!node) return null;
  if (node.isText) return { text: node.data };
  const out = { tag: node.tagName.toLowerCase() };
  if (node.className) out.class = node.className;
  const kids = node.children.filter((c) => c && (c.tagName || (c.isText && c.data)));
  if (kids.length) out.children = kids.map(shape);
  return out;
}

/** All element tags in a rendered tree, in document order. */
function tags(node, acc = []) {
  for (const c of node.children || []) {
    if (c && c.tagName) {
      acc.push(c.tagName.toLowerCase());
      tags(c, acc);
    }
  }
  return acc;
}

const render = (md) => app.renderProseLines(md.split("\n"));

/* -------------------------------------------------------------------- tests */

test("the DOM stub has no innerHTML, so the renderer cannot be using it", () => {
  const probe = new StubNode("div");
  assert.equal("innerHTML" in probe, false);

  // Strip comments first: the files talk about innerHTML a lot on purpose.
  const source = readAllWebJs()
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

  for (const banned of ["innerHTML", "outerHTML", "insertAdjacentHTML", "document.write", "eval("]) {
    assert.ok(!source.includes(banned), `web js must not use ${banned}`);
  }
});

test("nested lists become nested list elements", () => {
  const out = render(["- one", "  - one a", "  - one b", "- two"].join("\n"));
  assert.deepEqual(tags(out), ["ul", "li", "ul", "li", "li", "li"]);

  const outer = out.children[0];
  assert.equal(outer.children.length, 2, "two top-level items");
  const nested = outer.children[0].lastElementChild;
  assert.equal(nested.tagName, "UL");
  assert.deepEqual(
    nested.children.map((li) => li.textContent),
    ["one a", "one b"],
  );
  assert.equal(outer.children[1].textContent, "two");
});

test("an ordered list nested in an unordered one keeps both types", () => {
  const out = render(["- steps:", "  1. first", "  2. second", "- done"].join("\n"));
  assert.deepEqual(tags(out), ["ul", "li", "ol", "li", "li", "li"]);
  const ol = out.children[0].children[0].lastElementChild;
  assert.equal(ol.tagName, "OL");
  assert.deepEqual(ol.children.map((li) => li.textContent), ["first", "second"]);
});

test("an indented plain line continues the item above it", () => {
  const out = render(["- a claim", "  with more detail", "- next"].join("\n"));
  const items = out.children[0].children;
  assert.equal(items.length, 2);
  assert.equal(items[0].textContent, "a claim with more detail");
});

test("switching marker type at the same depth starts a sibling list", () => {
  const out = render(["- bullet", "1. number"].join("\n"));
  assert.deepEqual(tags(out), ["ul", "li", "ol", "li"]);
});

test("task list items render a checkbox instead of a bullet", () => {
  const out = render(["- [x] done", "- [ ] todo"].join("\n"));
  const items = out.children[0].children;
  assert.equal(items.length, 2);
  assert.match(items[0].textContent, /^\u2611 done$/);
  assert.match(items[1].textContent, /^\u2610 todo$/);
  assert.equal(items[0].className, "md-task-item");
});

test("tables work with or without the outer pipes", () => {
  const withPipes = render(["| a | b |", "| --- | --- |", "| 1 | 2 |"].join("\n"));
  const without = render(["a | b", "--- | ---", "1 | 2"].join("\n"));

  for (const [label, out] of [["with pipes", withPipes], ["without pipes", without]]) {
    const table = out.children[0];
    assert.equal(table.tagName, "TABLE", label);
    const head = table.children[0].children[0];
    assert.deepEqual(head.children.map((th) => th.textContent), ["a", "b"], `${label}: header`);
    const row = table.children[1].children[0];
    assert.deepEqual(row.children.map((td) => td.textContent), ["1", "2"], `${label}: body`);
  }
});

test("a table right after a paragraph is not swallowed by it", () => {
  // Regression: the paragraph collector had no stop condition for table rows,
  // so a table with no blank line above it became part of the sentence.
  const out = render(["Here are the results:", "| a | b |", "| - | - |", "| 1 | 2 |"].join("\n"));
  assert.deepEqual(tags(out).slice(0, 2), ["p", "table"]);
  assert.equal(out.children[0].textContent, "Here are the results:");
});

test("a list right after a paragraph is not swallowed either", () => {
  const out = render(["Reasons:", "- first", "- second"].join("\n"));
  assert.deepEqual(tags(out), ["p", "ul", "li", "li"]);
});

test("--- is a rule, but |---| under a header is a table separator", () => {
  const rule = render(["text", "", "---", "", "more"].join("\n"));
  assert.ok(tags(rule).includes("hr"));
  assert.ok(!tags(rule).includes("table"));
});

test("inline code wins over emphasis inside it", () => {
  const out = render("use `a ** b` and **really** bold");
  const p = out.children[0];
  const kinds = p.children.map((c) => (c.isText ? "text" : c.tagName.toLowerCase()));
  assert.deepEqual(kinds, ["text", "code", "text", "strong", "text"]);
  assert.equal(p.children[1].textContent, "a ** b");
  assert.equal(p.children[3].textContent, "really");
});

test("strikethrough, italic and links render as elements, links never as anchors", () => {
  const out = render("~~gone~~ and *soft* and [docs](https://example.com)");
  const p = out.children[0];
  const kinds = p.children.map((c) => (c.isText ? "text" : c.tagName.toLowerCase()));
  assert.deepEqual(kinds, ["s", "text", "em", "text", "span"]);
  assert.equal(tags(out).includes("a"), false, "a link must not become a clickable anchor");
  assert.match(p.textContent, /docs \(https:\/\/example\.com\)/);
});

test("headings, blockquotes and code fences still work", () => {
  const out = render(["## Title", "> quoted", "> more"].join("\n"));
  assert.deepEqual(tags(out).slice(0, 3), ["h4", "blockquote", "p"]);
  assert.equal(out.children[0].textContent, "Title");
  assert.equal(out.children[1].children[0].textContent, "quoted more");

  // splitFences builds its array inside the vm realm, so copy it before the
  // strict comparison, which would otherwise trip over the foreign prototype.
  const fences = app.splitFences("intro\n```js\ncode()\n```\nafter");
  assert.deepEqual(Array.from(fences, (f) => f.type), ["text", "code", "text"]);
  assert.equal(fences[1].text, "code()");
  assert.equal(fences[1].lang, "js");
});

test("a malformed list cannot hang the renderer", () => {
  // Any input must terminate: this used to be a real risk in the nesting loop.
  for (const md of ["-", "- \n  \n-", "1.", "   - deep first", "- a\n    - b\n  - c\n- d"]) {
    const out = render(md);
    assert.ok(out, `no output for ${JSON.stringify(md)}`);
  }
});

test("diff output is detected and coloured line by line", () => {
  assert.equal(app.looksLikeDiff("Edited a.js\n@@ -1,2 +1,3 @@\n-old\n+new"), true);
  assert.equal(app.looksLikeDiff("just some text"), false);
  assert.equal(app.looksLikeDiff(null), false);

  const block = app.diffPre("@@ -1,1 +1,1 @@\n-old\n+new\n unchanged");
  const spans = block.children[0].children;
  assert.deepEqual(
    spans.map((s) => s.className),
    ["diff-meta", "diff-del", "diff-add", "diff-ctx"],
  );
  assert.equal(spans[1].textContent, "-old\n");
});

test("every id app.js asks for exists in index.html", () => {
  // A typo in $("cfg-something") is silent until the moment you tap the control.
  const js = readAllWebJs();
  const html = fs.readFileSync(path.join(SRC, "web", "index.html"), "utf8");

  const ids = new Set(Array.from(js.matchAll(/\$\("([a-zA-Z0-9_-]+)"\)/g), (m) => m[1]));
  assert.ok(ids.size > 40, `only found ${ids.size} ids, the pattern probably broke`);

  const missing = [...ids].filter((id) => !html.includes(`id="${id}"`)).sort();
  assert.deepEqual(missing, [], `index.html has no element with id: ${missing.join(", ")}`);
});

/* -------------------------------------------------------------------- i18n */

test("every data-i18n key in index.html is defined in both languages", () => {
  const html = fs.readFileSync(path.join(SRC, "web", "index.html"), "utf8");
  const keys = new Set();
  for (const attr of ["data-i18n", "data-i18n-ph", "data-i18n-aria"]) {
    for (const m of html.matchAll(new RegExp(`${attr}="([^"]+)"`, "g"))) keys.add(m[1]);
  }
  assert.ok(keys.size > 50, `only ${keys.size} keys marked up; the pass looks incomplete`);

  for (const lang of ["vi", "en"]) {
    const missing = [...keys].filter((k) => !(k in DICT[lang])).sort();
    assert.deepEqual(missing, [], `${lang} has no text for: ${missing.join(", ")}`);
  }
});

test("every key app.js asks t() for is defined", () => {
  // The mirror of the test above: markup keys and code keys both have to exist,
  // or half the UI silently renders dotted key names.
  const js = readAllWebJs();
  const keys = new Set(Array.from(js.matchAll(/\bt\("([a-z][a-zA-Z0-9_.]+)"/g), (m) => m[1]));
  assert.ok(keys.size > 30, `only ${keys.size} t() calls found; the pattern probably broke`);

  for (const lang of ["vi", "en"]) {
    const missing = [...keys].filter((k) => !(k in DICT[lang])).sort();
    assert.deepEqual(missing, [], `${lang} has no text for: ${missing.join(", ")}`);
  }
});

test("no English UI text is left hardcoded where a key exists", () => {
  // Not a general lint - just the specific strings that used to be inline and
  // would silently stay English after a language switch.
  const js = readAllWebJs();
  const banned = [
    '"Working\\u2026"',
    '"Session deleted"',
    '"Config reloaded from disk"',
    '"Allow"',
    '"Deny"',
    '"Show"',
    '"Hide"',
    '"Copied"',
    '"Test failed."',
    '"Connection OK."',
    '"Downloading\\u2026"',
    '"No messages yet. Describe what you want changed."',
    '"Not running under Termux',
  ];
  for (const s of banned) {
    assert.ok(!js.includes(s), `web js still hardcodes ${s}; it should call t()`);
  }
});

test("the app loads the real table and t() resolves through it", () => {
  assert.equal(typeof app.t, "function");
  assert.equal(typeof app.applyI18n, "function");
  assert.equal(app.normaliseLang("vi-VN"), "vi");
  assert.equal(app.normaliseLang("en-GB"), "en");
  assert.equal(app.normaliseLang("de"), "vi", "an unsupported language falls back to Vietnamese");

  // navigator.language is "en" in the stub, so that is the language it picked.
  assert.equal(app.t("tab.chat"), DICT.en["tab.chat"]);
  assert.equal(app.t("common.size", { n: 7 }), "7 MB");
  // A key with no entry comes back as itself, so a bug is visible rather than blank.
  assert.equal(app.t("no.such.key"), "no.such.key");
});

test("applyI18n fills text, placeholders and aria-labels, and skips unknown keys", () => {
  const text = new StubNode("button");
  text.textContent = "Chat";
  text.dataset.i18n = "tab.chat";

  const ph = new StubNode("textarea");
  ph.dataset.i18nPh = "chat.placeholder";

  const aria = new StubNode("div");
  aria.dataset.i18nAria = "chat.conversation";

  const unknown = new StubNode("p");
  unknown.textContent = "left alone";
  unknown.dataset.i18n = "no.such.key";

  const root = {
    querySelectorAll: (sel) =>
      sel === "[data-i18n]" ? [text, unknown] : sel === "[data-i18n-ph]" ? [ph] : [aria],
  };

  app.setLang("vi", { persistToServer: false });
  app.applyI18n(root);
  assert.equal(text.textContent, DICT.vi["tab.chat"]);
  assert.equal(ph.getAttribute("placeholder"), DICT.vi["chat.placeholder"]);
  assert.equal(aria.getAttribute("aria-label"), DICT.vi["chat.conversation"]);
  // A key with no translation must not blank the fallback already in the HTML.
  assert.equal(unknown.textContent, "left alone");

  // Switching is instant: both tables are already in memory, no refetch.
  app.setLang("en", { persistToServer: false });
  app.applyI18n(root);
  assert.equal(text.textContent, DICT.en["tab.chat"]);
  assert.equal(ph.getAttribute("placeholder"), DICT.en["chat.placeholder"]);
});

test("the tabs are declared once and switchTab is not hardcoded", () => {
  // switchTab used to resolve anything that was not "chat" to settings, so a
  // third tab was impossible without rewriting it. It stays table-driven even now
  // that there are two again, because that is what made removing one a one-line
  // change instead of a rewrite.
  const js = readAllWebJs();
  assert.match(js, /const TABS = \[/, "tabs should come from a table");
  for (const name of ["chat", "settings"]) {
    assert.ok(js.includes(`name: "${name}"`), `TABS is missing ${name}`);
  }

  const html = fs.readFileSync(path.join(SRC, "web", "index.html"), "utf8");
  // The Power tab is gone: everything it installed is installed by install.sh in
  // one pass, and the diagnostics it showed live in `tca doctor`. Nothing may be
  // left pointing at it, in either direction.
  for (const dead of ["tab-power", "panel-power", "power-body", "btn-recheck-power"]) {
    assert.ok(!html.includes(`id="${dead}"`), `index.html still has #${dead}`);
    assert.ok(!js.includes(dead), `web js still references ${dead}`);
  }

  // aria-controls must point at something that exists, or the tablist lies to
  // assistive tech.
  for (const m of html.matchAll(/aria-controls="([^"]+)"/g)) {
    assert.ok(html.includes(`id="${m[1]}"`), `aria-controls="${m[1]}" has no target`);
  }
});

test("no translation is defined that nothing uses", () => {
  // The other direction of rot: keys outlive the code that referenced them, the
  // table grows, and nobody dares delete anything.
  const sources = [
    readAllWebJs(),
    fs.readFileSync(path.join(SRC, "web", "index.html"), "utf8"),
    fs.readFileSync(path.join(SRC, "capabilities.js"), "utf8"),
    fs.readFileSync(path.join(SRC, "privilege.js"), "utf8"),
    fs.readFileSync(path.join(SRC, "status.js"), "utf8"),
    fs.readFileSync(path.join(SRC, "cli.js"), "utf8"),
    fs.readFileSync(path.join(SRC, "daemon.js"), "utf8"),
  ].join("\n");

  // Some keys are assembled at runtime - `cap.${id}.title`, `tier.${tier}`,
  // `priv.${kind}.label` - so a plain text search cannot see them. Rebuild that
  // set from the same tables the code uses, rather than loosening the check.
  const computed = new Set();
  for (const cap of CAPABILITIES) {
    for (const part of ["title", "why", "fix"]) computed.add(`cap.${cap.id}.${part}`);
  }
  for (const tier of TIERS) computed.add(`tier.${tier}`), computed.add(`tier.${tier}.hint`);
  for (const kind of ["root", "rish", "adb", "none"]) {
    computed.add(`priv.${kind}.label`);
    computed.add(`priv.${kind}.detail`);
  }
  for (const status of ["pending", "in_progress", "done"]) computed.add(`todo.status.${status}`);
  for (const m of ["pair", "shizuku", "root", "recheck"]) {
    computed.add(`priv.method.${m}.title`);
    computed.add(`priv.method.${m}.desc`);
  }
  for (const u of UNLOCKS) computed.add(u.labelKey);

  const unused = Object.keys(DICT.vi)
    .filter((k) => !computed.has(k) && !sources.includes(k))
    .sort();
  assert.deepEqual(unused, [], `nothing references: ${unused.join(", ")}`);
});

test("the dead Android-status markup and CSS are gone with it", () => {
  // The flat doctor list moved into the Power panel, which shows the same checks
  // grouped by benefit. Leaving the old fieldset behind would mean two places
  // rendering the same data.
  const html = fs.readFileSync(path.join(SRC, "web", "index.html"), "utf8");
  const js = readAllWebJs();
  const css = fs.readFileSync(path.join(SRC, "web", "style.css"), "utf8");
  for (const dead of ["status-list", "btn-recheck-status", "loadAndroidStatus", "renderAndroidStatus"]) {
    assert.ok(!html.includes(dead), `index.html still has ${dead}`);
    assert.ok(!js.includes(dead), `web js still has ${dead}`);
  }
  for (const rule of [".status-row", ".status-dot", ".status-label", ".status-fix"]) {
    assert.ok(!css.includes(rule), `style.css still has dead rule ${rule}`);
  }
});

/* ------------------------------------------------------------- highlighting */

/** Highlighted output as [class, text] pairs; plain runs get an empty class. */
function tokens(code, lang) {
  const frag = app.highlight(code, lang);
  return frag.children.map((c) => (c.isText ? ["", c.data] : [c.className, c.textContent]));
}

/** All text back out, which must always equal the input exactly. */
const rejoin = (code, lang) => tokens(code, lang).map(([, t]) => t).join("");

test("the highlighter never alters the text it was given", () => {
  // The one property that matters. A mis-coloured token is cosmetic; a dropped or
  // duplicated character means the user is reading code that was never written.
  const samples = [
    ["js", "const x = 'a\\'b'; // note\nfn(1, 2.5)"],
    ["py", "def f(a):\n    return a # done"],
    ["json", '{"a": [1, true, null]}'],
    ["sh", "for f in *.js; do echo $f; done # loop"],
    ["go", "func main() {\n\tfmt.Println(`x`)\n}"],
    ["sql", "select * from t where a = 1 -- why"],
    ["html", "<p class='x'>hi</p>"],
    ["", "plain text with ` and ' and \" in it"],
    ["nonsense-lang", "some ** unparseable /* text"],
    ["js", ""],
    ["js", "/* unterminated block comment"],
    ["js", "'unterminated string"],
  ];
  for (const [lang, code] of samples) {
    assert.equal(rejoin(code, lang), code, `${lang || "plain"} lost or changed text`);
  }
});

test("an unknown language is left as one plain text node", () => {
  assert.deepEqual(tokens("anything at all", "cobol"), [["", "anything at all"]]);
  assert.deepEqual(tokens("no lang tag", ""), [["", "no lang tag"]]);
  // Markdown is deliberately not highlighted: it is prose, and colouring its
  // punctuation as code makes it harder to read, not easier.
  assert.deepEqual(tokens("# heading", "md"), [["", "# heading"]]);
});

test("comments and strings win over the keywords inside them", () => {
  const commented = tokens("// return false\n", "js");
  assert.deepEqual(commented[0], ["tok-comment", "// return false"]);
  assert.ok(
    !commented.some(([cls]) => cls === "tok-kw"),
    "a keyword inside a comment must not be coloured as code",
  );

  const stringy = tokens("'return null'", "js");
  assert.deepEqual(stringy, [["tok-str", "'return null'"]]);
});

test("keywords, numbers and calls each get their own class", () => {
  const got = tokens("const n = 42; doThing(n)", "js");
  const byClass = new Map(got.filter(([c]) => c).map(([c, t]) => [c, t]));
  assert.equal(byClass.get("tok-kw"), "const");
  assert.equal(byClass.get("tok-num"), "42");
  assert.equal(byClass.get("tok-fn"), "doThing");
});

test("the language tag is normalised, so ```js title=x still highlights", () => {
  assert.ok(tokens("const x = 1", "JS").some(([c]) => c === "tok-kw"));
  assert.ok(tokens("const x = 1", "js:src/a.js").some(([c]) => c === "tok-kw"));
  assert.ok(tokens("const x = 1", "js extra").some(([c]) => c === "tok-kw"));
});

test("a code block carries its language, a copy button and highlighted code", () => {
  const block = app.codeBlock("const a = 1;", "js");
  assert.equal(block.className, "code");
  const head = block.children[0];
  assert.equal(head.children[0].textContent, "js");
  assert.equal(head.children[1].tagName, "BUTTON");
  const pre = block.children[1];
  assert.equal(pre.tagName, "PRE");
  assert.equal(pre.textContent, "const a = 1;");
  assert.ok(
    pre.children[0].children.some((c) => c.className === "tok-kw"),
    "the code should be tokenised, not one flat text node",
  );

  // An untagged block still renders, just without colour.
  const plain = app.codeBlock("???", "");
  assert.equal(plain.children[0].children[0].textContent, "text");
  assert.equal(plain.children[1].textContent, "???");
});

test("every element app.js reaches for exists in index.html", () => {
  // $("...") returns null for a missing id and the next property access throws,
  // which in a browser kills the whole script - including the parts that do work.
  // Nothing else catches this: the DOM stub above hands back an element for any
  // id, on purpose, so the renderer tests do not need markup.
  const asked = new Set();
  for (const m of readAllWebJs().matchAll(/\$\("([a-z0-9-]+)"\)/g)) asked.add(m[1]);
  const present = new Set();
  for (const m of fs.readFileSync(path.join(SRC, "web", "index.html"), "utf8").matchAll(/id="([a-z0-9-]+)"/g)) present.add(m[1]);

  assert.ok(asked.size > 40, `only found ${asked.size} lookups; the pattern probably broke`);
  const missing = [...asked].filter((id) => !present.has(id)).sort();
  assert.deepEqual(missing, [], `index.html has no element with id: ${missing.join(", ")}`);
});
