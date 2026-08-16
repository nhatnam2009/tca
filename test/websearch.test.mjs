/**
 * Web search, and starting on boot.
 *
 * The search parser is scraping, so the important thing is that a change to
 * DuckDuckGo's page fails here rather than silently returning "no results" to the
 * model forever. The fixture below is the page shape as of writing; if this test
 * goes red, the selectors in src/websearch.js need updating, and that is exactly
 * the signal it exists to give.
 *
 * No test in this file touches the network.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "tca-web-"));
const WORKSPACE = path.join(TMP, "workspace");
fs.mkdirSync(WORKSPACE, { recursive: true });
process.env.TCA_HOME = path.join(TMP, "state");
process.env.TCA_CONFIG = path.join(TMP, "config.json");

const { parseResults, unwrapUrl, SELECTORS, search } = await import("../src/websearch.js");
const { callTool } = await import("../src/tools.js");

/**
 * The lite endpoint's shape: a flat table, class attributes in single quotes,
 * href BEFORE class, and the snippet in a sibling row rather than inside the
 * result. Copied from a real response.
 */
const LITE_PAGE = `<!DOCTYPE html><html><body>
  <table border="0">
      <tr>
        <td valign="top">1.&nbsp;</td>
        <td>
          <a rel="nofollow" href="https://nodejs.org/api/fs.html" class='result-link'>File system | Node.js &amp; docs</a>
        </td>
      </tr>
      <tr>
        <td>&nbsp;&nbsp;&nbsp;</td>
        <td class='result-snippet'>
          The <b>fs</b> module enables interacting with the file&nbsp;system.
        </td>
      </tr>
      <tr>
        <td>&nbsp;&nbsp;&nbsp;</td>
        <td><span class='link-text'>nodejs.org/api/fs.html</span></td>
      </tr>

      <tr>
        <td valign="top">2.&nbsp;</td>
        <td>
          <a rel="nofollow" href="https://www.geeksforgeeks.org/node-js/x/" class='result-link'>Node JS fs.readFile() Method</a>
        </td>
      </tr>
      <tr>
        <td>&nbsp;&nbsp;&nbsp;</td>
        <td class='result-snippet'>Second snippet</td>
      </tr>

      <tr>
        <td valign="top">3.&nbsp;</td>
        <td>
          <a rel="nofollow" href="javascript:alert(1)" class='result-link'>Hostile href</a>
        </td>
      </tr>
  </table>
</body></html>`;

/**
 * The html endpoint's shape: nested divs, class attributes in double quotes,
 * class BEFORE href, and the snippet inside the result block. Also copied from a
 * real response, and kept because a change to one endpoint usually leaves the
 * other working - which is the whole reason both are tried.
 */
const HTML_PAGE = `<!DOCTYPE html><html><body>
<div class="results">
  <div class="result results_links results_links_deep web-result">
    <h2 class="result__title">
      <a class="result__a" rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fone&amp;rut=abc">
        Redirector still works
      </a>
    </h2>
    <a class="result__snippet" href="#">Snippet <b>one</b></a>
  </div>
  <div class="result results_links web-result">
    <h2 class="result__title">
      <a class="result__a" rel="nofollow" href="https://example.com/two">Direct link</a>
    </h2>
    <a class="result__snippet" href="#">Snippet two</a>
  </div>
</div>
</body></html>`;

const EMPTY_PAGE = `<!DOCTYPE html><html><body>
<div class="no-results">No results found.</div>
</body></html>`;

/* ------------------------------------------------------------------ parsing */

test("the lite endpoint's table layout is read correctly", () => {
  const results = parseResults(LITE_PAGE);
  assert.equal(results.length, 2, `expected two usable results, got ${JSON.stringify(results, null, 2)}`);

  assert.equal(results[0].title, "File system | Node.js & docs", "entities have to be decoded");
  assert.equal(results[0].url, "https://nodejs.org/api/fs.html");
  assert.equal(
    results[0].snippet,
    "The fs module enables interacting with the file system.",
    "tags stripped, &nbsp; turned into a space",
  );

  // The snippet lives in a sibling row, so pairing is by position: result two
  // must not pick up result one's snippet, or anything after itself.
  assert.equal(results[1].title, "Node JS fs.readFile() Method");
  assert.equal(results[1].snippet, "Second snippet");
});

test("the html endpoint's nested layout is read correctly too", () => {
  // href comes after class here and before it on the other endpoint; that
  // asymmetry is exactly what a single href-then-class regex would break on.
  const results = parseResults(HTML_PAGE);
  assert.equal(results.length, 2, JSON.stringify(results, null, 2));
  assert.equal(results[0].url, "https://example.com/one", "the old redirector must still be unwrapped");
  assert.equal(results[0].snippet, "Snippet one");
  assert.equal(results[1].url, "https://example.com/two");
  assert.equal(results[1].snippet, "Snippet two");
});

test("a href that is not a page is dropped rather than handed to the model", () => {
  const results = parseResults(LITE_PAGE);
  assert.ok(!results.some((r) => r.url.startsWith("javascript:")), "javascript: must never survive");
  assert.equal(unwrapUrl("javascript:alert(1)"), "");
  assert.equal(unwrapUrl("data:text/html,<script>"), "");
  // A redirector pointing at something that is not a page is no better.
  assert.equal(unwrapUrl("//duckduckgo.com/l/?uddg=javascript%3Aalert(1)"), "");
  // A relative or empty href must not resolve against the endpoint: that would
  // turn a broken link into the search page's own URL, and the agent would fetch
  // it and read nothing useful.
  assert.equal(unwrapUrl(""), "");
  assert.equal(unwrapUrl("   "), "");
  assert.equal(unwrapUrl("/relative/path"), "");
  assert.equal(unwrapUrl("not a url at all"), "");
  // A protocol-relative redirector is the normal case and must work.
  assert.equal(unwrapUrl("//duckduckgo.com/l/?uddg=https%3A%2F%2Fa.example%2Fb"), "https://a.example/b");
});

test("the result limit is honoured", () => {
  assert.equal(parseResults(LITE_PAGE, 1).length, 1);
  assert.equal(parseResults(LITE_PAGE, 99).length, 2);
});

test("an empty page and an unreadable page are different answers", () => {
  // Genuinely nothing found: the page says so, and that is a valid result.
  assert.equal(parseResults(EMPTY_PAGE).length, 0);
  assert.match(EMPTY_PAGE, SELECTORS.noResults);

  // A page we can no longer read must NOT look like "no results", because the
  // two need completely different responses from a human.
  const changed = `<html><body><div class="brand-new-markup"><a href="https://x.example">Hi</a></div></body></html>`;
  assert.equal(parseResults(changed).length, 0);
  assert.ok(!SELECTORS.noResults.test(changed), "an unknown page must not match the no-results marker");
});

test("every part of the page shape is a named constant, so a fix is one line", () => {
  for (const key of ["anchor", "titleClass", "snippet", "href", "noResults"]) {
    assert.ok(SELECTORS[key] instanceof RegExp, `SELECTORS.${key} is missing`);
  }
  const src = fs.readFileSync(new URL("../src/websearch.js", import.meta.url), "utf8");
  // The parser must go through the table rather than inlining a class name.
  const body = src.slice(src.indexOf("export function parseResults"));
  for (const inlined of ["result__a", "result-link", "result-snippet", "result__snippet"]) {
    assert.ok(!body.includes(inlined), `parseResults should use SELECTORS, not inline ${inlined}`);
  }
});

test("search rejects an empty query before making a request", async () => {
  for (const q of ["", "   ", null, undefined]) {
    const res = await search({ query: /** @type {any} */ (q) });
    assert.equal(res.ok, false);
    assert.equal(/** @type {any} */ (res).reason, "empty query");
  }
});

test("the web_search tool validates its input", async () => {
  const ctx = { workspace: WORKSPACE, autoApproveCommands: true, approve: async () => true };
  for (const input of [{}, { query: "" }, { query: "   " }]) {
    const res = await callTool("web_search", input, ctx);
    assert.equal(res.ok, false, `${JSON.stringify(input)} should be rejected`);
    assert.match(res.output, /query is required/);
  }
});

test("web_search is offered to the model with usable guidance", async () => {
  const { TOOLS } = await import("../src/tools.js");
  const spec = TOOLS.web_search.spec;
  assert.equal(spec.parameters.required.length, 1);
  // The snippets are never enough to write code from; the model has to be told to
  // follow up, or it will confidently guess an API from a one-line summary.
  assert.match(spec.description, /read_url/);
});

/* --------------------------------------------------------------- boot script */

test("the boot script is written, is executable, and points at this checkout", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tca-boot-"));
  const original = process.env.HOME;
  process.env.HOME = home;
  try {
    const { installBootScript, bootScriptPath, bootScriptPresent, removeBootScript } = await import(
      `../src/privilege.js?boot=${Date.now()}`
    );

    assert.equal(bootScriptPresent(), false);

    const cli = path.join(home, "tca", "src", "cli.js");
    const res = installBootScript(cli);
    assert.equal(res.ok, true);
    assert.equal(res.path, bootScriptPath());
    // Termux:Boot only runs files inside ~/.termux/boot.
    assert.match(bootScriptPath().split(path.sep).join("/"), /\.termux\/boot\//);

    const body = fs.readFileSync(bootScriptPath(), "utf8");
    assert.match(body, /^#!/, "it has to have a shebang to be runnable");
    assert.ok(body.includes(JSON.stringify(cli)), "the path must be quoted, in case it has a space");
    assert.match(body, /termux-wake-lock/, "without a wake lock Android suspends it straight away");
    assert.match(body, /serve/);

    if (process.platform !== "win32") {
      assert.ok(fs.statSync(bootScriptPath()).mode & 0o100, "the owner execute bit is what makes it run");
    }

    // Rewriting is how you point it at a moved checkout.
    const moved = path.join(home, "elsewhere", "src", "cli.js");
    installBootScript(moved);
    assert.ok(fs.readFileSync(bootScriptPath(), "utf8").includes(JSON.stringify(moved)));

    assert.equal(removeBootScript().ok, true);
    assert.equal(bootScriptPresent(), false);
  } finally {
    if (original === undefined) delete process.env.HOME;
    else process.env.HOME = original;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("start-on-boot is a listed capability, and the route is Termux-only", async (t) => {
  const { CAPABILITIES } = await import("../src/capabilities.js");
  const boot = CAPABILITIES.find((c) => c.id === "boot");
  assert.ok(boot, "the catalogue should list it");
  assert.equal(boot.termuxOnly, true);
  assert.equal(boot.packages, undefined, "it writes a file; there is no package to install");

  fs.writeFileSync(process.env.TCA_CONFIG, JSON.stringify({ active: "", providers: {}, workspace: WORKSPACE }));
  const { serve } = await import("../src/daemon.js");
  const { server, port, token } = await serve({ port: 0, quiet: true });
  t.after(() => server.close());

  const call = (body) =>
    fetch(`http://127.0.0.1:${port}/api/privilege/boot-script`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  // Asserted against the environment rather than against a fixed 400. Hardcoding
  // "there is no Termux:Boot on a dev machine" made this test fail on the one
  // platform the project is for, which is the wrong way round: a suite that cannot
  // be green on the target device stops being a signal there.
  if (process.env.TERMUX_VERSION) {
    const res = await call({});
    assert.equal(res.status, 200, "on Termux the script is installable");
    const body = await res.json();
    assert.ok(body.path, "it should say where it wrote the script");

    // Undo it, so running the suite does not leave a boot hook behind on the phone.
    const removed = await call({ remove: true });
    assert.equal(removed.status, 200);
  } else {
    const res = await call({});
    assert.equal(res.status, 400, "off Termux there is no Termux:Boot to install into");
  }
});
