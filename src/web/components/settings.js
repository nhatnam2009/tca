/**
 * Settings tab component: provider configuration, model picker, catalog, testing.
 *
 * Rules:
 *   - API keys are never shown in plain text unless requested or placeholder;
 *   - live model discovery & catalog search assist model selection;
 *   - config changes persist safely to disk.
 */

import { $, el, option, t, toast, fail, PLACEHOLDER_KEY, fmtContext, fmtPrice, modelLabel, normaliseLang, testPending, testResult } from "../helpers.js";
import { api } from "../api.js";

export const KEEP = "__keep__";

export let modelChoices = [];
let searchTimer = 0;

export function setKeyVisible(show) {
  const btn = $("btn-toggle-key");
  const keyInput = $("prov-apikey");
  if (keyInput) keyInput.type = show ? "text" : "password";
  if (btn) {
    btn.textContent = show ? t("provider.hide") : t("provider.show");
    btn.setAttribute("aria-pressed", String(show));
  }
}

export function fillProvider(cfg, provId) {
  const p = (cfg && cfg.providers && cfg.providers[provId]) || {};
  if ($("prov-kind")) $("prov-kind").value = p.kind === "anthropic" ? "anthropic" : "openai";
  if ($("prov-baseurl")) $("prov-baseurl").value = p.baseUrl || "";
  if ($("prov-maxtokens")) $("prov-maxtokens").value = p.maxTokens ?? 8192;
  if ($("prov-thinking")) $("prov-thinking").value = p.thinkingBudget ?? 0;
  if ($("prov-cache")) $("prov-cache").checked = p.promptCache !== false;
  if ($("prov-model")) $("prov-model").value = p.model || "";

  const list = $("model-list");
  if (list) {
    list.textContent = "";
    for (const m of p.models || []) list.appendChild(option(m, m));
  }

  const key = $("prov-apikey");
  if (key) {
    if (p.apiKey === KEEP) {
      key.value = "";
      key.placeholder = "\u2022\u2022\u2022\u2022\u2022\u2022 stored on server";
      key.dataset.keep = "1";
    } else {
      key.value = p.apiKey || "";
      key.placeholder = "sk-\u2026 or ${ENV_NAME}";
      delete key.dataset.keep;
    }
  }
  setKeyVisible(PLACEHOLDER_KEY.test(p.apiKey || ""));
  const rmBtn = $("btn-remove-provider");
  if (rmBtn) rmBtn.disabled = !provId || !cfg.providers || !cfg.providers[provId];
  renderSavedModelIds(cfg, provId);

  const testRes = $("provider-test-result");
  if (testRes) testRes.hidden = true;
  fillModelPicker(provId, cfg).catch(() => {});
}

export function renderSavedModelIds(cfg, provId) {
  const host = $("saved-model-ids");
  if (!host) return;
  host.textContent = "";
  const p = (cfg && cfg.providers && cfg.providers[provId]) || {};
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
      const provModel = $("prov-model");
      if (provModel) {
        provModel.value = m;
        provModel.dispatchEvent(new Event("input"));
      }
    });
    const rm = document.createElement("button");
    rm.type = "button";
    rm.className = "chip-x";
    rm.textContent = "\u00d7";
    rm.setAttribute("aria-label", `Remove saved model id ${m}`);
    rm.addEventListener("click", () => {
      p.models = models.filter((x) => x !== m);
      renderSavedModelIds(cfg, provId);
      toast(t("ui.removedRememberSave"));
    });
    chip.append(btn, rm);
    host.appendChild(chip);
  }
}

export function saveCurrentModelId(cfg, provId) {
  const modelInput = $("prov-model");
  const id = modelInput ? modelInput.value.trim() : "";
  if (!id) return toast(t("ui.pickModelFirst"), "error");
  const p = (cfg && cfg.providers && cfg.providers[provId]) || {};
  if (!Array.isArray(p.models)) p.models = [];
  if (p.models.includes(id)) return toast(t("ui.alreadySaved", { id }));
  p.models.push(id);
  renderSavedModelIds(cfg, provId);
  toast(t("ui.savedRememberSave"));
}

export function fillSettings(cfg, provId, lang) {
  const sel = $("active-provider");
  if (sel) {
    sel.textContent = "";
    for (const id of Object.keys(cfg.providers || {})) sel.appendChild(option(id, id));
    sel.value = provId;
  }
  if ($("cfg-workspace")) $("cfg-workspace").value = cfg.workspace || "";
  if ($("cfg-autoapprove")) $("cfg-autoapprove").checked = Boolean(cfg.autoApproveCommands);
  if ($("cfg-autoapprove-edits")) $("cfg-autoapprove-edits").checked = cfg.autoApproveEdits !== false;
  if ($("cfg-verify-edits")) $("cfg-verify-edits").checked = cfg.verifyEdits !== false;
  if ($("cfg-lang")) $("cfg-lang").value = normaliseLang(cfg.lang || lang);
  if ($("cfg-instructions")) $("cfg-instructions").value = cfg.instructions || "";
  if ($("cfg-deny")) $("cfg-deny").value = (cfg.denyCommands || []).join("\n");
  const budget = cfg.budget || {};
  if ($("cfg-budget-cost")) $("cfg-budget-cost").value = budget.maxCostPerSession || "";
  if ($("cfg-budget-tokens")) $("cfg-budget-tokens").value = budget.maxTokensPerSession || "";
  if ($("cfg-budget-warn")) $("cfg-budget-warn").value = budget.warnAtPercent ?? 80;
  const perms = cfg.permissions || {};
  if ($("perm-bash")) $("perm-bash").value = perms.bash || "ask";
  if ($("perm-git")) $("perm-git").value = perms.git || "allow";
  if ($("perm-file-write")) $("perm-file-write").value = perms.file_write || "allow";
  if ($("perm-file-read")) $("perm-file-read").value = perms.file_read || "allow";
  if ($("perm-web-search")) $("perm-web-search").value = perms.web_search || "allow";
  if ($("perm-subagent")) $("perm-subagent").value = perms.subagent || "ask";
  fillProvider(cfg, provId);
}


function modelSearchText(m) {
  return `${m?.id || ""} ${m?.name || ""}`.toLowerCase();
}

export function renderModelLibrary(models, current = "", cfg = null, provId = null) {
  const host = $("model-library");
  const search = $("model-library-search");
  const count = $("model-library-count");
  if (!host) return;
  const q = (search?.value || "").trim().toLowerCase();
  const seen = new Set();
  const items = [];
  for (const m of (models || [])) {
    if (!m?.id || seen.has(m.id)) continue;
    seen.add(m.id);
    if (q && !modelSearchText(m).includes(q)) continue;
    items.push(m);
  }
  host.textContent = "";
  if (count) count.textContent = `${items.length} model${items.length === 1 ? "" : "s"}`;
  if (!items.length) {
    host.appendChild(el("div", "model-empty", q ? "No matching models." : "No models discovered yet. Tap Scan provider."));
    return;
  }
  for (const m of items) {
    const active = m.id === current;
    const card = el("button", `model-card${active ? " active" : ""}`);
    card.type = "button";
    card.dataset.modelId = m.id;
    const top = el("div", "model-card-top");
    top.appendChild(el("strong", "model-card-name", m.name || m.id));
    if (active) top.appendChild(el("span", "model-active", "ACTIVE"));
    card.appendChild(top);
    card.appendChild(el("code", "model-card-id", m.id));
    const meta = [fmtContext(m), fmtPrice(m), m.reasoning ? "reasoning" : ""].filter(Boolean).join(" · ");
    if (meta) card.appendChild(el("span", "model-card-meta", meta));
    card.addEventListener("click", () => {
      const input = $("prov-model");
      const sel = $("model-picker");
      if (input) { input.value = m.id; input.dispatchEvent(new Event("input", { bubbles: true })); }
      if (sel) sel.value = m.id;
      renderModelLibrary(models, m.id, cfg, provId);
    });
    host.appendChild(card);
  }
}

export async function fillModelPicker(provId, cfg, override) {
  const sel = $("model-picker");
  const note = $("model-picker-note");
  if (!sel || !note) return;
  sel.textContent = "";
  sel.hidden = true;
  note.className = "muted small";

  let list = override && override.models;
  if (list) {
    note.textContent = override.note || "";
  } else {
    note.textContent = "Loading model list…";
    try {
      const res = await api(`/api/catalog?provider=${encodeURIComponent(provId || "")}`);
      list = (res && res.models) || [];
      note.textContent = list.length
        ? `${list.length} catalog models available. Scan provider for the live list.`
        : `No catalog models. Scan provider to discover its actual /models list.`;
    } catch (err) {
      list = [];
      note.className = "warn small";
      note.textContent = err.message;
    }
  }

  // Preserve the provider's discovered/saved IDs and merge them with catalog/live data.
  const p = cfg?.providers?.[provId] || {};
  const saved = Array.isArray(p.models) ? p.models : [];
  const merged = [];
  const seen = new Set();
  for (const m of list || []) {
    const item = typeof m === "string" ? { id: m, name: m } : m;
    if (!item?.id || seen.has(item.id)) continue;
    seen.add(item.id); merged.push(item);
  }
  for (const id of saved) {
    if (!id || seen.has(id)) continue;
    seen.add(id); merged.push({ id, name: id });
  }
  modelChoices = merged;

  const dl = $("model-list");
  if (dl) dl.textContent = "";
  for (const m of merged) if (dl) dl.appendChild(option(m.id, m.name || m.id));

  const current = $("prov-model") ? $("prov-model").value.trim() : "";
  sel.textContent = "";
  for (const m of merged) sel.appendChild(option(m.id, modelLabel(m)));
  sel.value = current;
  renderModelLibrary(merged, current, cfg, provId);
}

export function renderCatalogInfo(state, providersInfo) {
  const info = (state && state.catalog) || (providersInfo && providersInfo.catalog) || null;
  const line = $("catalog-info");
  const btn = $("btn-download-catalog");
  if (!line || !btn) return;
  if (!info) {
    line.textContent = "";
    return;
  }
  line.textContent = t("catalog.info", {
    source: t(info.source === "full" ? "catalog.source.full" : "catalog.source.seed"),
    models: info.modelCount,
    providers: info.providerCount,
    generated: info.generated,
  });
  btn.textContent = info.source === "full" ? t("catalog.redownload") : t("catalog.download");
}

export async function downloadCatalog(state, onUpdated) {
  const btn = $("btn-download-catalog");
  if (!btn || !confirm(t("catalog.downloadConfirm"))) return;
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = t("catalog.downloading");
  try {
    const res = await api("/api/catalog/download", { method: "POST" });
    if (res && res.catalog && state) state.catalog = res.catalog;
    if (typeof onUpdated === "function") await onUpdated(res);
    toast(t("catalog.updated", { models: res.models, providers: res.providers }));
  } catch (err) {
    fail(err);
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

export async function testActiveProvider(provId) {
  const btn = $("btn-test-provider");
  const out = $("provider-test-result");
  const modelInput = $("prov-model");
  const model = modelInput ? modelInput.value.trim() : "";
  if (btn) btn.disabled = true;
  if (out) testPending(out, t("provider.testing"));
  try {
    const res = await api("/api/providers/test", {
      method: "POST",
      body: { id: provId, ...(model ? { model } : {}) },
    });
    if (out) testResult(out, res);
  } catch (err) {
    if (err.message === "Unauthorized") {
      if (out) out.hidden = true;
    } else {
      if (out) testResult(out, { ok: false, error: err.message });
    }
  } finally {
    if (btn) btn.disabled = false;
  }
}

export async function refreshLiveModels(provId, cfg) {
  const btn = $("btn-refresh-live");
  const note = $("model-picker-note");
  const keyInput = $("prov-apikey");
  const baseInput = $("prov-baseurl");
  const apiKey = keyInput && keyInput.value ? keyInput.value.trim() : (cfg && cfg.providers && cfg.providers[provId] && cfg.providers[provId].apiKey) || "";
  const baseUrl = baseInput && baseInput.value ? baseInput.value.trim() : (cfg && cfg.providers && cfg.providers[provId] && cfg.providers[provId].baseUrl) || "";
  if (btn) btn.disabled = true;
  if (note) {
    note.className = "muted small";
    note.textContent = "Asking the provider\u2026";
  }
  try {
    const res = await api(`/api/providers/${encodeURIComponent(provId || "")}/discover`, {
      method: "POST",
      body: { apiKey, baseUrl, force: true },
    });
    const models = (res && res.models) || [];
    const providerCfg = cfg?.providers?.[provId];
    if (providerCfg) {
      const ids = models.map((m) => typeof m === "string" ? m : m?.id).filter(Boolean);
      providerCfg.models = [...new Set([...(providerCfg.models || []), ...ids])];
    }
    await fillModelPicker(provId, cfg, {
      models,
      note: models.length
        ? `${models.length} models reported by ${provId} right now.`
        : `${provId} reported no models. Load one on the server, then refresh.`,
    });
  } catch (err) {
    if (err.message !== "Unauthorized" && note) {
      note.className = "warn small";
      note.textContent = err.message;
    }
  } finally {
    if (btn) btn.disabled = false;
  }
}

let keyDebounceTimer = null;
export function scheduleKeyDiscovery(provId, cfg, onDiscovered) {
  clearTimeout(keyDebounceTimer);
  keyDebounceTimer = setTimeout(async () => {
    const keyInput = $("prov-apikey");
    const baseInput = $("prov-baseurl");
    const apiKey = keyInput && keyInput.value ? keyInput.value.trim() : "";
    const baseUrl = baseInput && baseInput.value ? baseInput.value.trim() : "";
    if (!apiKey) return;
    try {
      const res = await api(`/api/providers/${encodeURIComponent(provId || "")}/discover`, {
        method: "POST",
        body: { apiKey, baseUrl, force: false },
      });
      const models = (res && res.models) || [];
      if (models.length > 0) {
        const providerCfg = cfg?.providers?.[provId];
        if (providerCfg) {
          const ids = models.map((m) => typeof m === "string" ? m : m?.id).filter(Boolean);
          providerCfg.models = [...new Set([...(providerCfg.models || []), ...ids])];
        }
        await fillModelPicker(provId, cfg, { models });
        if (typeof onDiscovered === "function") onDiscovered(models);
      }
    } catch {
      // Non-fatal discovery fallback
    }
  }, 500);
}


export function scheduleModelSearch(query, onSelectHit) {
  clearTimeout(searchTimer);
  const q = query.trim();
  const searchNote = $("model-search-note");
  const searchResults = $("model-search-results");
  if (searchNote) searchNote.hidden = true;
  if (!q) {
    if (searchResults) searchResults.textContent = "";
    return;
  }
  searchTimer = setTimeout(() => runModelSearch(q, onSelectHit), 250);
}

export async function runModelSearch(q, onSelectHit) {
  const host = $("model-search-results");
  if (!host) return;
  host.textContent = "";
  host.appendChild(el("p", "muted small", t("ui.searching")));
  try {
    const res = await api(`/api/catalog/search?q=${encodeURIComponent(q)}`);
    renderHits((res && res.hits) || [], onSelectHit);
  } catch (err) {
    host.textContent = "";
    if (err.message !== "Unauthorized") host.appendChild(el("p", "warn small", err.message));
  }
}

export function renderHits(hits, onSelectHit) {
  const host = $("model-search-results");
  if (!host) return;
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
    btn.addEventListener("click", () => {
      if (typeof onSelectHit === "function") onSelectHit(hit);
    });
    host.appendChild(btn);
  }
}

export function readProvider(cfg, provId) {
  if (!cfg.providers) cfg.providers = {};
  const p = (cfg.providers[provId] = cfg.providers[provId] || {});
  if ($("prov-kind")) p.kind = $("prov-kind").value;
  if ($("prov-baseurl")) p.baseUrl = $("prov-baseurl").value.trim();
  if ($("prov-model")) p.model = $("prov-model").value.trim();
  if ($("prov-maxtokens")) p.maxTokens = Number($("prov-maxtokens").value) || 8192;
  if ($("prov-thinking")) p.thinkingBudget = Math.max(0, Number($("prov-thinking").value) || 0);
  if ($("prov-cache")) p.promptCache = $("prov-cache").checked;
  if (!Array.isArray(p.models)) p.models = [];
  const key = $("prov-apikey");
  if (key) {
    p.apiKey = key.dataset.keep === "1" && key.value === "" ? KEEP : key.value.trim();
  }
}

export function readSettings(cfg, provId) {
  readProvider(cfg, provId);
  cfg.active = provId;
  if ($("cfg-workspace")) cfg.workspace = $("cfg-workspace").value.trim();
  if ($("cfg-autoapprove")) cfg.autoApproveCommands = $("cfg-autoapprove").checked;
  if ($("cfg-autoapprove-edits")) cfg.autoApproveEdits = $("cfg-autoapprove-edits").checked;
  if ($("cfg-verify-edits")) cfg.verifyEdits = $("cfg-verify-edits").checked;
  if ($("cfg-lang")) cfg.lang = normaliseLang($("cfg-lang").value);
  if ($("cfg-instructions")) cfg.instructions = $("cfg-instructions").value;
  if ($("cfg-deny")) cfg.denyCommands = $("cfg-deny").value.split("\n").map((s) => s.trim()).filter(Boolean);
  if (!cfg.budget) cfg.budget = {};
  if ($("cfg-budget-cost")) cfg.budget.maxCostPerSession = Math.max(0, Number($("cfg-budget-cost").value) || 0);
  if ($("cfg-budget-tokens")) cfg.budget.maxTokensPerSession = Math.max(0, Number($("cfg-budget-tokens").value) || 0);
  if ($("cfg-budget-warn")) cfg.budget.warnAtPercent = Math.max(1, Math.min(100, Number($("cfg-budget-warn").value) || 80));
  if (!cfg.permissions) cfg.permissions = {};
  if ($("perm-bash")) cfg.permissions.bash = $("perm-bash").value;
  if ($("perm-git")) cfg.permissions.git = $("perm-git").value;
  if ($("perm-file-write")) cfg.permissions.file_write = $("perm-file-write").value;
  if ($("perm-file-read")) cfg.permissions.file_read = $("perm-file-read").value;
  if ($("perm-web-search")) cfg.permissions.web_search = $("perm-web-search").value;
  if ($("perm-subagent")) cfg.permissions.subagent = $("perm-subagent").value;
}

export function render(state) {
  const cfgPath = $("cfg-path");
  if (cfgPath && state && state.state) {
    cfgPath.textContent = state.state.configPath || "unknown";
  }
  const versionLine = $("version-line");
  if (versionLine && state && state.state) {
    versionLine.textContent = `tca ${state.state.version || ""}`.trim();
  }
  const shared = $("shared-storage-note");
  if (shared && state && state.state) {
    shared.hidden = !state.state.configInSharedStorage;
    shared.textContent = state.state.configInSharedStorage ? t("settings.sharedWarning") : "";
  }
}

export function bindEvents({
  onSaveSettings,
  onActiveProviderChange,
  onAddProvider,
  onRemoveProvider,
  onSaveModelId,
  onReloadConfig,
  onLangChange,
  onModelPickerChange,
  onModelInput,
  onTestProvider,
  onRefreshLive,
  onDownloadCatalog,
  onModelSearch,
}) {
  const form = $("settings-form");
  if (form && onSaveSettings) {
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      onSaveSettings();
    });
  }
  const activeProv = $("active-provider");
  if (activeProv && onActiveProviderChange) {
    activeProv.addEventListener("change", (e) => onActiveProviderChange(e.target.value));
  }
  const keyInput = $("prov-apikey");
  if (keyInput) {
    keyInput.addEventListener("input", (e) => {
      delete e.target.dataset.keep;
      if (onKeyInput) onKeyInput(e.target.value);
    });
  }
  const toggleKey = $("btn-toggle-key");
  if (toggleKey) {
    toggleKey.addEventListener("click", () => {
      setKeyVisible(toggleKey.getAttribute("aria-pressed") !== "true");
    });
  }
  const addBtn = $("btn-add-provider");
  if (addBtn && onAddProvider) addBtn.addEventListener("click", onAddProvider);
  const rmBtn = $("btn-remove-provider");
  if (rmBtn && onRemoveProvider) rmBtn.addEventListener("click", onRemoveProvider);
  const saveModelBtn = $("btn-save-model-id");
  if (saveModelBtn && onSaveModelId) saveModelBtn.addEventListener("click", onSaveModelId);
  const modelLibrarySearch = $("model-library-search");
  if (modelLibrarySearch && actions.onModelLibrarySearch) {
    modelLibrarySearch.addEventListener("input", actions.onModelLibrarySearch);
  }
  const reloadBtn = $("btn-reload-config");
  if (reloadBtn && onReloadConfig) reloadBtn.addEventListener("click", onReloadConfig);
  const langSel = $("cfg-lang");
  if (langSel && onLangChange) langSel.addEventListener("change", (e) => onLangChange(e.target.value));
  const modelPick = $("model-picker");
  if (modelPick && onModelPickerChange) modelPick.addEventListener("change", onModelPickerChange);
  const provModel = $("prov-model");
  if (provModel && onModelInput) provModel.addEventListener("input", onModelInput);
  const testBtn = $("btn-test-provider");
  if (testBtn && onTestProvider) testBtn.addEventListener("click", onTestProvider);
  const refreshBtn = $("btn-refresh-live");
  if (refreshBtn && onRefreshLive) refreshBtn.addEventListener("click", onRefreshLive);
  const dlBtn = $("btn-download-catalog");
  if (dlBtn && onDownloadCatalog) dlBtn.addEventListener("click", onDownloadCatalog);
  const searchInput = $("model-search");
  if (searchInput && onModelSearch) {
    searchInput.addEventListener("input", (e) => onModelSearch(e.target.value));
  }
}

export const Settings = {
  KEEP,
  modelChoices,
  setKeyVisible,
  fillProvider,
  renderSavedModelIds,
  saveCurrentModelId,
  fillSettings,
  fillModelPicker,
  renderModelLibrary,
  renderCatalogInfo,
  downloadCatalog,
  testActiveProvider,
  refreshLiveModels,
  scheduleKeyDiscovery,
  scheduleModelSearch,
  runModelSearch,
  renderHits,
  readProvider,
  readSettings,
  render,
  bindEvents,
};


