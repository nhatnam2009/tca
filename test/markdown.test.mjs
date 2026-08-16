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

/* ------------------------------------------------------------------ DOM stub */

class StubNode {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.attrs = {};
    this.className = "";
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
    navigator: { clipboard: { writeText: async () => {} } },
    fetch: async () => {
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
