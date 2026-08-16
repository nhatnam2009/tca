/**
 * Web search.
 *
 * The agent could already fetch a URL but had no way to find one, which meant it
 * could not look up an API it did not already know. That is a real ceiling on what
 * it can do, and closing it needs no API key: DuckDuckGo serves plain HTML.
 *
 * The catch, stated plainly: this is scraping. Three things make that survivable
 * rather than mysterious when the page changes:
 *
 *   - two endpoints are tried, the small one first. They have different markup, so
 *     a change to one usually leaves the other working.
 *   - every part of the page shape is a named entry in SELECTORS below, so a fix
 *     is one line rather than an archaeology exercise.
 *   - "I read the page and there was nothing" and "I could not read the page" are
 *     reported differently, because they need completely different responses from
 *     a human. A parser that has stopped working must not look like a quiet query
 *     with no hits.
 *
 * Anchors are matched as whole tags and their attributes read afterwards, rather
 * than with one regex that assumes href comes before class. It does on one
 * endpoint and after it on the other, and that asymmetry is exactly the sort of
 * thing that silently breaks a scraper.
 */

/** Smallest page first: less mobile data, and simpler markup to read. */
const ENDPOINTS = ["https://lite.duckduckgo.com/lite/", "https://html.duckduckgo.com/html/"];
const TIMEOUT = 20_000;
const MAX_QUERY = 400;

/**
 * The page shape. If DuckDuckGo changes, this is the block to edit.
 * Class attributes are quoted with ' on one endpoint and " on the other, hence
 * the character classes.
 */
export const SELECTORS = {
  /** Any anchor; the class decides whether it is a result. */
  anchor: /<a\b([^>]*)>([\s\S]*?)<\/a>/gi,
  /** The class marking a result's title link, on either endpoint. */
  titleClass: /\b(?:result-link|result__a)\b/,
  /** The cell or anchor holding the snippet, with its text. */
  snippet: /class=['"][^'"]*\b(?:result-snippet|result__snippet)\b[^'"]*['"][^>]*>([\s\S]*?)<\/(?:td|a|div)>/gi,
  /** href="..." inside an anchor's attributes. */
  href: /\bhref=['"]([^'"]+)['"]/i,
  /** Said by the page itself when a query genuinely has no hits. */
  noResults: /\bno\s+results\b/i,
};

/** Undo the minimal entity set an HTML page actually uses. */
function decodeEntities(s) {
  const named = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
  return String(s)
    .replace(/&(?:#x([0-9a-f]+)|#(\d+)|([a-z]+));/gi, (m, hex, dec, name) => {
      if (hex) return String.fromCodePoint(parseInt(hex, 16));
      if (dec) return String.fromCodePoint(Number(dec));
      return named[String(name).toLowerCase()] ?? m;
    })
    .replace(/\u00a0/g, " ");
}

/** Strip tags and collapse whitespace: the model wants prose, not markup. */
function text(html) {
  return decodeEntities(String(html).replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Turn a result href into a URL worth fetching.
 *
 * DuckDuckGo used to wrap every outbound link in its own redirector and now
 * mostly does not, so both shapes have to work: the real target is the `uddg`
 * parameter when it is there.
 * @param {string} href
 */
export function unwrapUrl(href) {
  const raw = decodeEntities(href).trim();
  if (!raw) return "";
  const withScheme = raw.startsWith("//") ? `https:${raw}` : raw;
  // Must be absolute. Resolving a relative href against the endpoint would turn a
  // broken link into the search page's own URL, which is worse than dropping it:
  // the agent would fetch it and read nothing useful.
  if (!/^[a-z][a-z0-9+.-]*:/i.test(withScheme)) return "";
  try {
    const url = new URL(withScheme);
    const target = url.searchParams.get("uddg");
    if (target) return /^https?:\/\//i.test(target) ? target : "";
    // Only http(s) is useful, and it keeps a javascript: href from being handed
    // to the model as though it were a page.
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : "";
  } catch {
    return "";
  }
}

/**
 * Pull results out of a results page.
 *
 * Snippets live in a sibling row on one endpoint and inside the result block on
 * the other, so they are matched separately and paired by position: each result
 * takes the first snippet that appears after its own link and before the next.
 * @param {string} html
 * @param {number} [limit]
 * @returns {Array<{title: string, url: string, snippet: string}>}
 */
export function parseResults(html, limit = 8) {
  const body = String(html);

  /** @type {Array<{at: number, url: string, title: string}>} */
  const links = [];
  for (const m of body.matchAll(SELECTORS.anchor)) {
    const attrs = m[1] || "";
    if (!SELECTORS.titleClass.test(attrs)) continue;
    const href = SELECTORS.href.exec(attrs);
    if (!href) continue;
    const url = unwrapUrl(href[1]);
    const title = text(m[2]);
    if (!url || !title) continue;
    links.push({ at: m.index ?? 0, url, title });
  }
  if (!links.length) return [];

  /** @type {Array<{at: number, body: string}>} */
  const snippets = [];
  for (const m of body.matchAll(SELECTORS.snippet)) snippets.push({ at: m.index ?? 0, body: m[1] });

  const out = [];
  for (const [i, link] of links.entries()) {
    const until = i + 1 < links.length ? links[i + 1].at : Infinity;
    const found = snippets.find((s) => s.at > link.at && s.at < until);
    out.push({ title: link.title, url: link.url, snippet: found ? text(found.body) : "" });
    if (out.length >= limit) break;
  }
  return out;
}

/** @param {string} endpoint @param {string} q @param {AbortSignal} signal */
async function fetchPage(endpoint, q, signal) {
  const res = await fetch(endpoint, {
    method: "POST",
    signal,
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      // Without a normal-looking agent the HTML endpoints answer 202 with a page
      // that has no results on it at all.
      "user-agent":
        "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36",
      accept: "text/html,application/xhtml+xml",
      "accept-language": "en-US,en;q=0.9",
    },
    body: new URLSearchParams({ q, kl: "wt-wt" }).toString(),
  });
  return { status: res.status, html: await res.text() };
}

/**
 * Run a search.
 *
 * Returns a reason rather than throwing on the ordinary failures - offline, rate
 * limited, page changed - because the agent copes with a tool error far better
 * than with a dead turn, and "search is unavailable" is something it can work
 * around.
 *
 * @param {{query: string, limit?: number, signal?: AbortSignal}} o
 * @returns {Promise<{ok: true, results: Array<{title: string, url: string, snippet: string}>} | {ok: false, reason: string}>}
 */
export async function search({ query, limit = 8, signal }) {
  const q = String(query || "").trim().slice(0, MAX_QUERY);
  if (!q) return { ok: false, reason: "empty query" };

  const timer = new AbortController();
  const bail = setTimeout(() => timer.abort(), TIMEOUT);
  const onAbort = () => timer.abort();
  signal?.addEventListener("abort", onAbort, { once: true });

  const problems = [];
  try {
    for (const endpoint of ENDPOINTS) {
      let page;
      try {
        page = await fetchPage(endpoint, q, timer.signal);
      } catch (err) {
        if (timer.signal.aborted) return { ok: false, reason: "search timed out" };
        problems.push(`${endpoint}: ${/** @type {Error} */ (err).message}`);
        continue;
      }

      // 202 is DuckDuckGo's "come back later"; the body looks like a page but has
      // nothing in it, so treating it as zero results would be a lie.
      if (page.status !== 200) {
        problems.push(`${endpoint}: HTTP ${page.status}`);
        continue;
      }

      const results = parseResults(page.html, limit);
      if (results.length) return { ok: true, results };
      if (SELECTORS.noResults.test(page.html)) return { ok: true, results: [] };
      problems.push(`${endpoint}: page had no readable results`);
    }
  } finally {
    clearTimeout(bail);
    signal?.removeEventListener("abort", onAbort);
  }

  return {
    ok: false,
    reason:
      `search is unavailable right now (${problems.join("; ")}). ` +
      "If this keeps happening, DuckDuckGo's HTML has probably changed - see SELECTORS in src/websearch.js.",
  };
}
