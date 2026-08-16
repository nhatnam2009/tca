/**
 * HTTP API client and SSE stream manager for the tca web UI.
 *
 * Rules:
 *   - Bearer token on every request;
 *   - 401 returns to token gate and clears stored credentials;
 *   - SSE connection auto-reconnects on mobile network changes.
 */

import { $, store, t } from "./helpers.js";

export const TOKEN_KEY = "tca.token";
export const SESSION_KEY = "tca.session";

export let token = "";
export let stream = null; // EventSource

let onAuthFailure = null;

export function setAuthFailureHandler(fn) {
  onAuthFailure = fn;
}

export function setToken(val) {
  token = val || "";
  if (token) store.set(TOKEN_KEY, token);
  else store.del(TOKEN_KEY);
}

export function getToken() {
  if (!token) token = store.get(TOKEN_KEY);
  return token;
}

/** Take ?token= out of the URL and scrub it from the address bar / history. */
export function takeTokenFromUrl() {
  const url = new URL(location.href);
  const t = url.searchParams.get("token");
  if (!t) return "";
  url.searchParams.delete("token");
  const qs = url.searchParams.toString();
  history.replaceState(null, "", url.pathname + (qs ? `?${qs}` : "") + url.hash);
  return t;
}

export function showGate(message) {
  closeStream();
  const appEl = $("app");
  const gateEl = $("token-gate");
  if (appEl) appEl.hidden = true;
  if (gateEl) gateEl.hidden = false;
  const err = $("token-error");
  if (err) {
    err.hidden = !message;
    err.textContent = message || "";
  }
  const input = $("token-input");
  if (input) {
    input.value = "";
    input.focus();
  }
}

export function onUnauthorized() {
  setToken("");
  showGate(t("gate.rejected"));
  if (typeof onAuthFailure === "function") onAuthFailure();
}

/**
 * JSON fetch with the bearer token attached. Rejects on non-2xx; a 401 also
 * drops the stored token and re-opens the gate.
 */
export async function api(path, { method = "GET", body } = {}) {
  const headers = { Authorization: `Bearer ${token}` };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(path, {
    method,
    headers,
    cache: "no-store",
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401) {
    onUnauthorized();
    throw new Error("Unauthorized");
  }
  if (!res.ok) {
    let msg = `${method} ${path} failed (${res.status})`;
    let payload = null;
    try {
      payload = await res.json();
      if (payload && (payload.error || payload.message)) msg = String(payload.error || payload.message);
    } catch {}
    const err = new Error(msg);
    err.status = res.status;
    if (payload && payload.errKey) err.errKey = payload.errKey;
    if (payload) err.payload = payload;
    throw err;
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

export function closeStream() {
  if (stream) stream.close();
  stream = null;
}

export function openStream(id, { onOpen, onMessage, onError }) {
  closeStream();
  const url = `/api/sessions/${encodeURIComponent(id)}/events?token=${encodeURIComponent(token)}`;
  const es = new EventSource(url);
  stream = es;
  if (onOpen) es.addEventListener("open", onOpen);
  if (onMessage) {
    es.addEventListener("message", (e) => {
      let data;
      try { data = JSON.parse(e.data); } catch { return; }
      onMessage(data);
    });
  }
  if (onError) {
    es.addEventListener("error", () => onError(es));
  }
  return es;
}
