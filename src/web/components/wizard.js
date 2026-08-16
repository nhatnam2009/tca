/**
 * First-run wizard component: 4-step onboarding for setting up providers & models.
 *
 * Rules:
 *   - steps 1..4 (Provider -> API Key -> Model -> Test/Finish);
 *   - never writes to server until Finish;
 *   - skips API key step for local runtimes.
 */

import { $, el, option, t, toast, PLACEHOLDER_KEY, modelLabel, fmtContext, fmtPrice, testPending, testResult } from "../helpers.js";
import { api } from "../api.js";

export const TIERS = {
  start: { label: "Start here", hint: "Reliable defaults if you are not sure." },
  cheap: { label: "Cheap or free", hint: "Good value; fine for most edits." },
  max: { label: "Maximum capability", hint: "Expensive. Use for hard problems." },
};
export const TIER_ORDER = ["start", "cheap", "max"];

export let wiz = null;
export let providersInfo = null;

export const wizStatus = (text, bad) => {
  const p = $("wizard-status");
  if (!p) return;
  p.className = bad ? "meta warn" : "meta muted";
  p.textContent = text || "";
};

export function setProvidersInfo(info) {
  providersInfo = info;
}

export function providerEntry(id) {
  if (!providersInfo) return null;
  if (id === "other") return providersInfo.other || null;
  return (providersInfo.known || []).find((p) => p.id === id) || null;
}

export function providerName(id) {
  const entry = providerEntry(id);
  return (entry && entry.name) || id;
}

export function stepList() {
  return wiz && wiz.entry && wiz.entry.local ? [1, 3, 4] : [1, 2, 3, 4];
}

export function isOther() {
  return Boolean(wiz && (wiz.providerId === "other" || !(wiz.entry && wiz.entry.baseUrl)));
}

export async function enterWizard(opts = {}, { showViewFn, loadProvidersFn }) {
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
  if (showViewFn) showViewFn("wizard");
  wizStatus("Loading the provider list\u2026");
  try {
    if (loadProvidersFn) providersInfo = await loadProvidersFn();
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

export function exitWizard(target, onSwitchTab) {
  wiz = null;
  if (typeof onSwitchTab === "function") onSwitchTab(target === "settings" ? "settings" : "chat");
}

export function tierGroup(host, label, hint) {
  const head = el("div", "tier-head");
  head.appendChild(el("h3", "tier-label", label));
  if (hint) head.appendChild(el("p", "tier-hint muted small", hint));
  host.appendChild(head);
}

export function pickCard(providerId, model, title, why) {
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

export function renderRecommended() {
  const host = $("wiz-recommended");
  if (!host) return;
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

export function renderAllProviders() {
  const host = $("wiz-all");
  if (!host) return;
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

export function chooseProvider(id, model) {
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

export function markChosenCard() {
  for (const card of document.querySelectorAll("#panel-wizard .card")) {
    const on = wiz && card.dataset.provider === wiz.providerId && card.dataset.model === (wiz.model || "");
    card.classList.toggle("selected", on);
    card.setAttribute("aria-pressed", String(on));
  }
}

export function chosenText() {
  if (!wiz) return "";
  return [providerName(wiz.providerId), wiz.model].filter(Boolean).join(" \u00b7 ");
}

export function goStep(step) {
  wiz.step = step;
  for (const n of [1, 2, 3, 4]) {
    const sEl = $(`wizard-${n}`);
    if (sEl) sEl.hidden = n !== step;
  }

  const list = stepList();
  for (const n of [1, 2, 3, 4]) {
    const tick = $(`wizard-tick-${n}`);
    if (!tick) continue;
    const skipped = !list.includes(n);
    tick.classList.toggle("current", n === step);
    tick.classList.toggle("done", list.indexOf(n) > -1 && list.indexOf(n) < list.indexOf(step));
    tick.classList.toggle("skip", skipped);
    if (n === step) tick.setAttribute("aria-current", "step");
    else tick.removeAttribute("aria-current");
  }

  const last = step === list[list.length - 1];
  const next = $("btn-wiz-next");
  if (next) {
    next.textContent = last ? "Finish" : "Next";
    next.classList.toggle("primary", !last);
  }
  const back = $("btn-wiz-back");
  if (back) back.disabled = step === list[0];
  wizStatus("");

  if (step === 2) renderStep2();
  if (step === 3) renderStep3();
  if (step === 4) renderStep4();
  if (step === 1) markChosenCard();
  const panel = $("panel-wizard");
  if (panel) panel.scrollTop = 0;
}

export function goRelative(delta, { onFinish }) {
  const list = stepList();
  const at = list.indexOf(wiz.step);
  if (delta > 0) {
    const problem = validateStep(wiz.step);
    if (problem) return wizStatus(problem, true);
    if (at === list.length - 1) {
      if (typeof onFinish === "function") return onFinish();
      return wizardFinish();
    }
  }
  const target = list[Math.min(list.length - 1, Math.max(0, at + delta))];
  goStep(target);
}

export function validateStep(step) {
  if (step === 1 && !wiz.providerId) return "Tap one of the cards first.";
  if (step === 2) {
    if (isOther() && !readOtherFields()) return "Paste the base URL for this provider.";
    if (!wiz.apiKey) return "Paste the API key, or use ${ENV_NAME} to read it from the environment.";
  }
  if (step === 3) {
    const modelInput = $("wiz-model");
    if (modelInput) wiz.model = modelInput.value.trim();
    const localBaseUrl = $("wiz-local-baseurl");
    if (wiz.entry && wiz.entry.local && localBaseUrl) wiz.baseUrl = localBaseUrl.value.trim() || wiz.baseUrl;
    if (!wiz.model) return "A model id is required. Pick one, or type it in.";
    if (!wiz.baseUrl) return "A base URL is required.";
  }
  return "";
}

export function readOtherFields() {
  const labelInput = $("wiz-label");
  const baseUrlInput = $("wiz-baseurl");
  const kindInput = $("wiz-kind");
  if (labelInput) wiz.label = labelInput.value.trim();
  if (baseUrlInput) wiz.baseUrl = baseUrlInput.value.trim();
  if (kindInput) wiz.kind = kindInput.value === "anthropic" ? "anthropic" : "openai";
  return Boolean(wiz.baseUrl);
}

export function renderStep2() {
  const chosen2 = $("wiz-chosen-2");
  if (chosen2) chosen2.textContent = chosenText();
  const entry = wiz.entry || {};
  const note = $("wiz-provider-note");
  if (note) note.textContent = entry.note || "";

  const link = $("wiz-key-link");
  if (link) {
    link.textContent = "";
    if (typeof entry.keyUrl === "string" && /^https:\/\//.test(entry.keyUrl)) {
      const a = el("a", "keylink", t("ui.getApiKey"));
      a.href = entry.keyUrl;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      link.append(a, el("span", "muted small", ` \u2014 ${entry.keyUrl}`));
    }
  }

  const other = isOther();
  const otherFields = $("wiz-other-fields");
  if (otherFields) otherFields.hidden = !other;
  if (other) {
    if ($("wiz-label")) $("wiz-label").value = wiz.label || (wiz.providerId === "other" ? "" : wiz.providerId);
    if ($("wiz-baseurl")) $("wiz-baseurl").value = wiz.baseUrl || "";
    if ($("wiz-kind")) $("wiz-kind").value = wiz.kind;
  }

  const key = $("wiz-apikey");
  if (key) {
    key.value = wiz.apiKey || "";
    key.placeholder = entry.keyPrefix ? `${entry.keyPrefix}\u2026` : "sk-\u2026 or ${ENV_NAME}";
  }
  setWizKeyVisible(false);
  checkKeyPrefix();
}

export function setWizKeyVisible(show) {
  const btn = $("btn-wiz-toggle-key");
  const keyInput = $("wiz-apikey");
  if (keyInput) keyInput.type = show ? "text" : "password";
  if (btn) {
    btn.textContent = show ? t("provider.hide") : t("provider.show");
    btn.setAttribute("aria-pressed", String(show));
  }
}

export function checkKeyPrefix() {
  const warnEl = $("wiz-key-warning");
  if (!warnEl) return;
  const prefix = wiz.entry && wiz.entry.keyPrefix;
  const value = wiz.apiKey || "";
  const odd = prefix && value && !value.startsWith(prefix) && !PLACEHOLDER_KEY.test(value);
  warnEl.hidden = !odd;
  warnEl.textContent = odd
    ? `That does not look right: keys for this provider usually start with ${prefix}. You can continue anyway.`
    : "";
}

export function renderStep3() {
  const chosen3 = $("wiz-chosen-3");
  if (chosen3) chosen3.textContent = chosenText();
  const local = Boolean(wiz.entry && wiz.entry.local);
  const localFields = $("wiz-local-fields");
  if (localFields) localFields.hidden = !local;
  if (local && $("wiz-local-baseurl")) $("wiz-local-baseurl").value = wiz.baseUrl || "";
  if ($("wiz-model")) $("wiz-model").value = wiz.model || "";
  loadWizardModels(local ? "live" : "catalog").catch(() => {});
}


function renderWizardModelLibrary(models) {
  const host = $("wiz-model-library");
  const search = $("wiz-model-search");
  if (!host) return;
  const q = (search?.value || "").trim().toLowerCase();
  host.textContent = "";
  const filtered = (models || []).filter((m) => m?.id && (!q || `${m.id} ${m.name || ""}`.toLowerCase().includes(q)));
  if (!filtered.length) {
    host.appendChild(el("div", "model-empty", q ? "No matching models." : "No models found."));
    return;
  }
  for (const m of filtered) {
    const card = el("button", `model-card${m.id === wiz.model ? " active" : ""}`);
    card.type = "button";
    const top = el("div", "model-card-top");
    top.appendChild(el("strong", "model-card-name", m.name || m.id));
    if (m.id === wiz.model) top.appendChild(el("span", "model-active", "SELECTED"));
    card.appendChild(top);
    card.appendChild(el("code", "model-card-id", m.id));
    const meta = [fmtContext(m), fmtPrice(m), m.reasoning ? "reasoning" : ""].filter(Boolean).join(" · ");
    if (meta) card.appendChild(el("span", "model-card-meta", meta));
    card.addEventListener("click", () => {
      wiz.model = m.id;
      if ($("wiz-model")) $("wiz-model").value = m.id;
      if ($("wiz-model-select")) $("wiz-model-select").value = m.id;
      renderWizardModelLibrary(models);
      wizStatus("");
    });
    host.appendChild(card);
  }
}

export async function loadWizardModels(source) {
  const sel = $("wiz-model-select");
  const dl = $("wiz-model-list");
  const note = $("wiz-model-note");
  if (!sel || !note) return;
  sel.textContent = "";
  if (dl) dl.textContent = "";
  sel.appendChild(option("", "\u2014 choose a model \u2014"));
  note.className = "muted small";
  note.textContent = "Loading model list\u2026";

  const id = encodeURIComponent(wiz.providerId);
  try {
    const res = await api(`/api/providers/${id}/discover`, {
      method: "POST",
      body: { apiKey: wiz.apiKey || "", baseUrl: wiz.baseUrl || "", force: source === "live" },
    });
    const models = (res && res.models) || [];
    wiz.discoveredModels = models;
    renderWizardModelLibrary(models);
    for (const m of models) {
      if (!m || !m.id) continue;
      sel.appendChild(option(m.id, modelLabel(m)));
      if (dl) dl.appendChild(option(m.id, m.name || m.id));
    }
    if (wiz.model && models.some((m) => m.id === wiz.model)) sel.value = wiz.model;
    if (models.length) {
      note.textContent = `${models.length} models loaded. Prices are per 1M tokens and drift.`;
    } else {
      note.textContent = "Nothing found for this provider — type the model id yourself.";
    }
  } catch (err) {
    if (err.message === "Unauthorized") return;
    note.className = "warn small";
    note.textContent =
      `${err.message} \u2014 type the model id by hand, or finish setup and use ` +
      `"Refresh from provider" in Settings.`;
  }
}

export function summaryRow(host, label, value) {
  host.appendChild(el("dt", null, label));
  host.appendChild(el("dd", null, value));
}

export function renderStep4() {
  const host = $("wiz-summary");
  if (!host) return;
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
  const testRes = $("wiz-test-result");
  if (testRes) testRes.hidden = true;
}

export function wizardDraft() {
  return {
    kind: (wiz && wiz.kind) || "openai",
    baseUrl: ((wiz && wiz.baseUrl) || "").trim(),
    apiKey: (wiz && wiz.apiKey) || "",
    model: ((wiz && wiz.model) || "").trim(),
    maxTokens: 8192,
  };
}

export async function wizardTest() {
  const out = $("wiz-test-result");
  const problem = validateStep(3);
  if (problem) return testResult(out, { ok: false, error: problem });
  const btn = $("btn-wiz-test");
  if (btn) btn.disabled = true;
  testPending(out, "Sending one token to the provider\u2026");
  try {
    const draft = wizardDraft();
    const res = await api("/api/providers/test", {
      method: "POST",
      body: { provider: draft, model: draft.model },
    });
    testResult(out, res);
  } catch (err) {
    if (err.message === "Unauthorized") {
      if (out) out.hidden = true;
    } else {
      testResult(out, { ok: false, error: err.message });
    }
  } finally {
    if (btn) btn.disabled = false;
  }
}

export async function wizardFinish(callbacks = {}) {
  const draft = wizardDraft();
  const discoveredIds = Array.isArray(wiz.discoveredModels) ? wiz.discoveredModels.map((m) => m?.id).filter(Boolean) : [];
  const body = { id: wiz.providerId, kind: draft.kind, baseUrl: draft.baseUrl, model: draft.model, models: [...new Set(discoveredIds)] };
  if (draft.apiKey) body.apiKey = draft.apiKey;
  const label = wiz.label || (wiz.providerId === "other" ? "custom" : "");
  if (label) body.label = label;

  const next = $("btn-wiz-next");
  if (next) next.disabled = true;
  wizStatus("Saving\u2026");
  try {
    const res = await api("/api/providers", { method: "POST", body });
    const target = wiz.returnTo;
    wiz = null;
    if (callbacks.onFinished) await callbacks.onFinished(target, (res && res.id) || body.id);
    exitWizard(target, callbacks.onSwitchTab);
    toast(t("ui.providerReady", { id: (res && res.id) || body.id }));
  } catch (err) {
    if (err.message !== "Unauthorized") wizStatus(err.message, true);
  } finally {
    if (next) next.disabled = false;
  }
}

export function render() {}

export function bindEvents(actions = {}) {
  const showAllBtn = $("btn-show-all-providers");
  if (showAllBtn) {
    showAllBtn.addEventListener("click", () => {
      const show = showAllBtn.getAttribute("aria-expanded") !== "true";
      const wizAll = $("wiz-all");
      if (wizAll) wizAll.hidden = !show;
      showAllBtn.setAttribute("aria-expanded", String(show));
      showAllBtn.textContent = show ? "Hide the full provider list" : "Show all providers";
      if (show) markChosenCard();
    });
  }
  const apikeyInput = $("wiz-apikey");
  if (apikeyInput) {
    apikeyInput.addEventListener("input", (e) => {
      if (!wiz) return;
      wiz.apiKey = e.target.value.trim();
      checkKeyPrefix();
    });
  }
  const toggleKey = $("btn-wiz-toggle-key");
  if (toggleKey) {
    toggleKey.addEventListener("click", () => {
      setWizKeyVisible(toggleKey.getAttribute("aria-pressed") !== "true");
    });
  }
  const baseurlInput = $("wiz-baseurl");
  if (baseurlInput) baseurlInput.addEventListener("input", () => { if (wiz) readOtherFields(); });
  const labelInput = $("wiz-label");
  if (labelInput) labelInput.addEventListener("input", () => { if (wiz) readOtherFields(); });
  const kindInput = $("wiz-kind");
  if (kindInput) kindInput.addEventListener("change", () => { if (wiz) readOtherFields(); });
  const localBase = $("wiz-local-baseurl");
  if (localBase) {
    localBase.addEventListener("input", (e) => {
      if (wiz) wiz.baseUrl = e.target.value.trim();
    });
  }
  const liveBtn = $("btn-wiz-live");
  if (liveBtn) liveBtn.addEventListener("click", () => loadWizardModels("live").catch(() => {}));
  const wizardModelSearch = $("wiz-model-search");
  if (wizardModelSearch) wizardModelSearch.addEventListener("input", () => renderWizardModelLibrary(wiz?.discoveredModels || []));
  const modelSelect = $("wiz-model-select");
  if (modelSelect) {
    modelSelect.addEventListener("change", (e) => {
      if (!wiz || !e.target.value) return;
      wiz.model = e.target.value;
      if ($("wiz-model")) $("wiz-model").value = wiz.model;
      wizStatus("");
    });
  }
  const modelInput = $("wiz-model");
  if (modelInput) {
    modelInput.addEventListener("input", (e) => {
      if (!wiz) return;
      wiz.model = e.target.value.trim();
      const sel = $("wiz-model-select");
      if (sel && sel.value && sel.value !== wiz.model) sel.value = "";
      wizStatus("");
    });
  }
  const testBtn = $("btn-wiz-test");
  if (testBtn) testBtn.addEventListener("click", () => { if (wiz) wizardTest(); });
  const backBtn = $("btn-wiz-back");
  if (backBtn) backBtn.addEventListener("click", () => { if (wiz) goRelative(-1, actions); });
  const nextBtn = $("btn-wiz-next");
  if (nextBtn) nextBtn.addEventListener("click", () => { if (wiz) goRelative(1, actions); });
  const skipBtn = $("btn-wiz-skip");
  if (skipBtn) skipBtn.addEventListener("click", () => exitWizard("settings", actions.onSwitchTab));
}

export const Wizard = {
  TIERS,
  TIER_ORDER,
  wiz,
  providersInfo,
  wizStatus,
  setProvidersInfo,
  providerEntry,
  providerName,
  stepList,
  isOther,
  enterWizard,
  exitWizard,
  tierGroup,
  pickCard,
  renderRecommended,
  renderAllProviders,
  chooseProvider,
  markChosenCard,
  chosenText,
  goStep,
  goRelative,
  validateStep,
  readOtherFields,
  renderStep2,
  setWizKeyVisible,
  checkKeyPrefix,
  renderStep3,
  loadWizardModels,
  summaryRow,
  renderStep4,
  wizardDraft,
  wizardTest,
  wizardFinish,
  render,
  bindEvents,
};

