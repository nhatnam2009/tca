/**
 * DOM, i18n, storage and formatting helpers for the tca web UI.
 *
 * Rules:
 *   - zero dependencies, zero build step;
 *   - text is always set via textContent or Text nodes, never innerHTML;
 *   - all error/result messages formatted safely.
 */

export const $ = (id) => document.getElementById(id);

/** Create an element. `text` is always assigned as textContent (never parsed). */
export function el(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text != null) n.textContent = text;
  return n;
}

/** <option value=…>label</option> - used by both selects and the datalist. */
export function option(value, label) {
  const o = el("option", null, label);
  o.value = value;
  return o;
}

/** localStorage throws in some privacy modes - never let that break the app. */
export const store = {
  get: (k) => { try { return localStorage.getItem(k) || ""; } catch { return ""; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
  del: (k) => { try { localStorage.removeItem(k); } catch {} },
};

/* --------------------------------------------------------------------- i18n */

export const LANG_KEY = "tca.lang";
export let dict = { vi: {}, en: {} };
export let lang = "vi";

export async function loadI18n() {
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

export function normaliseLang(value) {
  const s = String(value || "").toLowerCase();
  for (const l of ["vi", "en"]) if (s.startsWith(l)) return l;
  return "vi";
}

/**
 * Translate. Falls back to English, then to the key, so a missing string is visible
 * as a bug rather than as blank space.
 * @param {string} key
 * @param {Record<string, string|number>} [params]
 */
export function t(key, params) {
  let s = (dict[lang] && dict[lang][key]) ?? (dict.en && dict.en[key]) ?? key;
  if (params) for (const [k, v] of Object.entries(params)) s = s.split(`{${k}}`).join(String(v));
  return s;
}

/** True when the table actually loaded, i.e. it is safe to replace HTML text. */
export const haveDict = () => Boolean(dict[lang] && Object.keys(dict[lang]).length);

/**
 * Fill in every marked element under `root`.
 *   data-i18n       -> textContent
 *   data-i18n-ph    -> placeholder
 *   data-i18n-aria  -> aria-label
 * Safe to call repeatedly; that is how switching language works.
 */
export function applyI18n(root = document) {
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
 * Switch language.
 */
export function setLang(next, { persistToServer = true, onLangChanged } = {}) {
  const value = normaliseLang(next);
  if (value === lang) return;
  lang = value;
  store.set(LANG_KEY, value);
  applyI18n(document);
  if (typeof onLangChanged === "function") onLangChanged(value, persistToServer);
}

/** An "${ENV_NAME}" apiKey is a pointer, not a secret: never mask it. */
export const PLACEHOLDER_KEY = /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/;

/* ------------------------------------------------- catalog value formatting */

/** 2 -> "2", 0.14 -> "0.14", 0 -> "0". Prices are USD per 1M tokens. */
export function money(n) {
  return String(Number(Number(n).toFixed(2)));
}

/** 1000000 -> "1M ctx", 262144 -> "262k ctx". */
export function fmtContext(ctx) {
  if (!ctx || typeof ctx !== "number") return "";
  if (ctx >= 1_000_000) return `${String(Math.round((ctx / 1_000_000) * 10) / 10)}M ctx`;
  if (ctx >= 1000) return `${Math.round(ctx / 1000)}k ctx`;
  return `${ctx} ctx`;
}

/** "$2/$10 per 1M", or "" when the catalog has no prices. */
export function fmtPrice(m) {
  if (!m || m.input_cost == null || m.output_cost == null) return "";
  return `$${money(m.input_cost)}/$${money(m.output_cost)} per 1M`;
}

/** One-line description of a catalog model, for <option> labels. */
export function modelLabel(m) {
  return [m.name || m.id, fmtContext(m.context), fmtPrice(m)].filter(Boolean).join(" \u00b7 ");
}

export function fmtTokens(n) {
  const v = Number(n) || 0;
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `${Math.round(v / 1000)}k`;
  return String(v);
}

/* ------------------------------------------------ connection-test rendering */

/** Spinner + text while POST /api/providers/test is in flight. */
export function testPending(node, text) {
  node.hidden = false;
  node.className = "test-result pending";
  node.textContent = "";
  node.append(el("span", "activity"), el("span", null, text));
}

/** Green success, or the server's sentence verbatim (it is already readable). */
export function testResult(node, res) {
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
export function toast(message, kind = "ok") {
  const toastEl = $("toast");
  if (!toastEl) return;
  toastEl.textContent = message;
  toastEl.className = `toast ${kind}`;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toastEl.hidden = true), 4000);
}

/** Report a rejected promise. A 401 already swapped the UI for the token gate. */
export function fail(err) {
  const msg = err && err.message ? err.message : String(err);
  if (msg !== "Unauthorized") toast(msg, "error");
}
