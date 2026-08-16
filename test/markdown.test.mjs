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

/** Load app.js with just enough globals that its top-level wire() survives. */
function loadApp() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const source = fs.readFileSync(path.join(here, "..", "src", "web", "app.js"), "utf8");

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
  vm.runInContext(source, sandbox, { filename: "app.js" });
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

  // Strip comments first: the file talks about innerHTML a lot on purpose.
  const source = fs
    .readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "web", "app.js"),
      "utf8",
    )
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

  for (const banned of ["innerHTML", "outerHTML", "insertAdjacentHTML", "document.write", "eval("]) {
    assert.ok(!source.includes(banned), `app.js must not use ${banned}`);
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
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "web");
  const js = fs.readFileSync(path.join(dir, "app.js"), "utf8");
  const html = fs.readFileSync(path.join(dir, "index.html"), "utf8");

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
  const js = fs.readFileSync(path.join(SRC, "web", "app.js"), "utf8");
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
  const js = fs.readFileSync(path.join(SRC, "web", "app.js"), "utf8");
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
    assert.ok(!js.includes(s), `app.js still hardcodes ${s}; it should call t()`);
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

test("the three tabs are declared once and switchTab is not hardcoded to two", () => {
  // switchTab used to resolve anything that was not "chat" to settings, so a
  // third tab was impossible without rewriting it.
  const js = fs.readFileSync(path.join(SRC, "web", "app.js"), "utf8");
  assert.match(js, /const TABS = \[/, "tabs should come from a table");
  for (const name of ["chat", "power", "settings"]) {
    assert.ok(js.includes(`name: "${name}"`), `TABS is missing ${name}`);
  }
  const html = fs.readFileSync(path.join(SRC, "web", "index.html"), "utf8");
  for (const id of ["tab-power", "panel-power"]) {
    assert.ok(html.includes(`id="${id}"`), `index.html is missing #${id}`);
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
    "web/app.js",
    "web/index.html",
    "capabilities.js",
    "privilege.js",
    "status.js",
    "cli.js",
    "daemon.js",
  ]
    .map((f) => fs.readFileSync(path.join(SRC, f), "utf8"))
    .join("\n");

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
  const js = fs.readFileSync(path.join(SRC, "web", "app.js"), "utf8");
  const css = fs.readFileSync(path.join(SRC, "web", "style.css"), "utf8");
  for (const dead of ["status-list", "btn-recheck-status", "loadAndroidStatus", "renderAndroidStatus"]) {
    assert.ok(!html.includes(dead), `index.html still has ${dead}`);
    assert.ok(!js.includes(dead), `app.js still has ${dead}`);
  }
  for (const rule of [".status-row", ".status-dot", ".status-label", ".status-fix"]) {
    assert.ok(!css.includes(rule), `style.css still has dead rule ${rule}`);
  }
});

test("every class the Power panel builds has a rule in the stylesheet", () => {
  // These elements are created in JS, so a typo is invisible: the element renders
  // unstyled and looks merely ugly rather than broken.
  const css = fs.readFileSync(path.join(SRC, "web", "style.css"), "utf8");
  const classes = [
    "power-score", "power-score-label", "power-score-value", "power-bar", "power-bar-fill",
    "power-group", "power-group-title", "power-item", "power-item-title", "power-item-why",
    "power-item-meta", "power-item-fix", "power-item-result", "power-ok-note", "power-log",
    "power-done", "power-done-count", "power-done-list",
    "priv-methods", "priv-method", "priv-method-title", "priv-method-desc",
    "priv-flow", "priv-flow-title", "priv-flow-result", "priv-back", "priv-steps",
    "priv-step-count", "priv-step-title", "priv-field", "priv-applied", "priv-applied-list",
    "todo", "todo-head", "todo-title", "todo-count", "todo-bar", "todo-bar-fill",
    "todo-list", "todo-item", "todo-mark", "todo-text",
    "power-caveat", "power-undo",
  ];
  const missing = classes.filter((c) => !css.includes(`.${c}`));
  assert.deepEqual(missing, [], `style.css has no rule for: ${missing.join(", ")}`);
});

/* -------------------------------------------------------------- power panel */

/** A capabilities payload shaped like the real one, with one gap per tier. */
function powerPayload({ termux = true, privKind = null } = {}) {
  const item = (id, ok, extra = {}) => ({
    id,
    tier: extra.tier || "recommended",
    weight: 2,
    ok,
    detail: extra.detail || "",
    params: {},
    packages: extra.packages || [],
    sizeMb: extra.sizeMb ?? null,
    installable: Boolean(extra.packages && extra.packages.length && termux),
    titleKey: `cap.${id}.title`,
    whyKey: `cap.${id}.why`,
    fixKey: `cap.${id}.fix`,
    title: `title-${id}`,
    why: `why-${id}`,
    fix: `fix-${id}`,
  });

  return {
    lang: "en",
    termux,
    score: { have: 6, total: 10, percent: 60 },
    privilege: {
      kind: privKind,
      labelKey: `priv.${privKind ?? "none"}.label`,
      detailKey: `priv.${privKind ?? "none"}.detail`,
      label: `label-${privKind ?? "none"}`,
      detail: `detail-${privKind ?? "none"}`,
      note: "",
      root: { available: false, note: "su not on PATH" },
      rish: { available: false, note: "missing: rish", files: { script: false, dex: false } },
      adb: { installed: true, connected: false, note: "" },
      phantomLimit: null,
      phantomLabel: "phantom-unknown",
    },
    envKeys: { names: [], label: "no keys" },
    groups: [
      {
        tier: "required",
        titleKey: "tier.required",
        hintKey: "tier.required.hint",
        title: "Required",
        hint: "hint-required",
        items: [item("node", true, { tier: "required", detail: "v22" }), item("provider", false, { tier: "required" })],
      },
      {
        tier: "recommended",
        titleKey: "tier.recommended",
        hintKey: "tier.recommended.hint",
        title: "Recommended",
        hint: "hint-recommended",
        items: [
          item("fast_search", false, { packages: ["ripgrep"], sizeMb: 4 }),
          item("git", true),
          item("storage", null),
        ],
      },
    ],
  };
}

test("the Power panel shows the score, the gaps, and folds away what works", () => {
  app.renderPower(powerPayload({ termux: true }));
  const root = shapeOf("power-body");

  // Score card first: the one number that says whether you are done.
  assert.equal(root.children[0].class, "power-score");
  assert.match(textOf(root.children[0]), /60%/);

  const tags = tags2(root);
  assert.ok(tags.includes("article"), "a missing capability should render a card");
  assert.ok(tags.includes("details"), "the working ones should be folded into a details");

  // The fold must be summarised, not expanded: two working items in the tiers.
  const done = collect(root, (n) => n.class === "power-done");
  assert.ok(done.length >= 1);
  assert.match(textOf(done[0]), /\u2713/);
});

test("an installable gap gets a button; one with its own flow does not", () => {
  app.renderPower(powerPayload({ termux: true }));
  const root = shapeOf("power-body");
  const cards = collect(root, (n) => n.class === "power-item bad");

  const withPkg = cards.find((c) => textOf(c).includes("title-fast_search"));
  assert.ok(withPkg, "the ripgrep gap should be on screen");
  assert.ok(collect(withPkg, (n) => n.tag === "button").length === 1, "it needs one install button");
  assert.match(textOf(withPkg), /ripgrep/, "the package and size belong on the card");
  assert.match(textOf(withPkg), /4 MB/);

  // `provider` has no package: it must show the instruction, not a dead button.
  const noPkg = cards.find((c) => textOf(c).includes("title-provider"));
  assert.ok(noPkg);
  assert.equal(collect(noPkg, (n) => n.tag === "button").length, 0);
  assert.match(textOf(noPkg), /fix-provider/);
});

test("with no privileged backend the panel offers all four routes, above the packages", () => {
  app.renderPower(powerPayload({ termux: true, privKind: null }));
  const root = shapeOf("power-body");

  const methods = collect(root, (n) => n.class === "priv-method");
  assert.equal(methods.length, 4, "recheck, pairing, Shizuku and root");
  const labels = methods.map(textOf).join(" | ");
  for (const key of [
    "priv.method.recheck.title",
    "priv.method.pair.title",
    "priv.method.shizuku.title",
    "priv.method.root.title",
  ]) {
    assert.ok(labels.includes(DICT.en[key]), `the method list is missing ${key}`);
  }

  // It is the one gap that silently breaks long tasks, so it must not sit below
  // a list of optional packages.
  const order = collect(root, (n) => n.class === "power-group power-priv" || n.class === "power-group");
  assert.equal(order[0].class, "power-group power-priv", "privileges come first when missing");
});

test("with a backend already working the panel collapses to a recheck", () => {
  app.renderPower(powerPayload({ termux: true, privKind: "rish" }));
  const root = shapeOf("power-body");
  assert.equal(collect(root, (n) => n.class === "priv-method").length, 0, "no method list once it works");
  const priv = collect(root, (n) => n.class === "power-group power-priv")[0];
  assert.ok(priv, "the privilege section should still be present");
  assert.match(textOf(priv), /label-rish/);
  assert.match(textOf(priv), new RegExp(DICT.en["common.recheck"]));

  // And it must be last: nothing to do there any more.
  const groups = collect(root, (n) => n.class === "power-group" || n.class === "power-group power-priv");
  assert.equal(groups[groups.length - 1].class, "power-group power-priv");
});

test("off Termux the panel says so and shows no privilege section", () => {
  app.renderPower(powerPayload({ termux: false }));
  const root = shapeOf("power-body");
  assert.equal(collect(root, (n) => n.class === "power-group power-priv").length, 0);
  assert.match(textOf(root), new RegExp(DICT.en["ui.notTermux"]));
});

/* ---------------------------------------------------- helpers for the above */

function shapeOf(id) {
  return shape(app.document.getElementById(id));
}

function tags2(node, acc = []) {
  for (const c of node.children || []) {
    if (c.tag) {
      acc.push(c.tag);
      tags2(c, acc);
    }
  }
  return acc;
}
function collect(node, pred, acc = []) {
  for (const c of node.children || []) {
    if (c.tag && pred(c)) acc.push(c);
    if (c.tag) collect(c, pred, acc);
  }
  return acc;
}
function textOf(node) {
  if (!node) return "";
  if (node.text) return node.text;
  return (node.children || []).map(textOf).join(" ");
}
