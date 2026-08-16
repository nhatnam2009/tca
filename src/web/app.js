/**
 * tca web UI - single page, modular component assembly.
 *
 * Rules this file follows:
 *   - no dependencies, no build step, nothing fetched from the network but this
 *     daemon (the phone may be offline apart from the LLM API);
 *   - every server- or model-provided string reaches the DOM through
 *     textContent, never innerHTML: tool output and file contents are untrusted;
 *   - phone first - 44px tap targets, Enter is a newline, no hover-only UI.
 */

import { $, el, store, toast, fail, t, loadI18n, applyI18n, setLang, LANG_KEY, normaliseLang } from "./helpers.js";
import { appState, resetMeterState, updateSpentUsage, setAppMode, setAppStreaming, setSessionId, setSessions, setServerConfig, setSettingsConfig, setSettingsProviderId } from "./state.js";
import { api, openStream, closeStream, takeTokenFromUrl, setToken, getToken, showGate, TOKEN_KEY, SESSION_KEY, setAuthFailureHandler } from "./api.js";
import { renderProseLines, splitFences, looksLikeDiff, diffPre, codeBlock, highlight } from "./markdown.js";
import * as Sidebar from "./components/sidebar.js";
import * as Chat from "./components/chat.js";
import * as ToolCard from "./components/toolcard.js";
import * as Approval from "./components/approval.js";
import * as TodoPanel from "./components/todopanel.js";
import * as StatusBar from "./components/statusbar.js";
import * as Settings from "./components/settings.js";
import * as Wizard from "./components/wizard.js";

export {
  renderProseLines,
  splitFences,
  looksLikeDiff,
  diffPre,
  codeBlock,
  highlight,
  t,
  applyI18n,
  normaliseLang,
  setLang,
};

/* --------------------------------------------------------------------- tabs */

export const TABS = [
  { name: "chat", tab: "tab-chat", panel: "panel-chat" },
  { name: "settings", tab: "tab-settings", panel: "panel-settings" },
];

export function showView(name) {
  const wizard = name === "wizard";
  for (const { name: n, panel } of TABS) {
    const p = $(panel);
    if (p) p.hidden = wizard || n !== name;
  }
  const wizPanel = $("panel-wizard");
  if (wizPanel) wizPanel.hidden = !wizard;
  const tabbar = $("tabbar");
  if (tabbar) tabbar.hidden = wizard;
}

export function switchTab(name) {
  Sidebar.closeDrawer();
  const target = TABS.some((x) => x.name === name) ? name : "chat";
  showView(target);
  for (const { name: n, tab } of TABS) {
    const on = n === target;
    const b = $(tab);
    if (b) {
      b.setAttribute("aria-selected", String(on));
      b.tabIndex = on ? 0 : -1;
      b.classList.toggle("active", on);
    }
  }
  if (target === "chat") Chat.scrollToBottom(true);
  else if (!appState.settingsLoaded) loadSettingsData(false).catch(fail);
}

/* ------------------------------------------------------------- state / mode */

export function setMode(next, persist = true) {
  setAppMode(next);
  const mode = appState.mode;
  const btn = $("btn-mode");
  if (btn) {
    btn.dataset.mode = mode;
    btn.textContent = mode === "plan" ? t("mode.plan") : t("mode.build");
    btn.setAttribute("aria-label", t(mode === "plan" ? "mode.plan.aria" : "mode.build.aria"));
    btn.setAttribute("aria-pressed", String(mode === "plan"));
  }
  document.body.classList.toggle("plan-mode", mode === "plan");
  if (persist) api("/api/mode", { method: "POST", body: { mode } }).catch(() => {});
}

export function redrawDynamicText() {
  try {
    if (appState.streaming) StatusBar.setStatus(t("chat.working"));
    Sidebar.fillSessionSelect(appState);
    Settings.renderCatalogInfo(appState.state, appState.providersInfo);
    setMode(appState.mode, false);
    StatusBar.renderMeter(appState);
  } catch {}
}

export async function refreshState() {
  appState.state = await api("/api/state");
  Chat.render(appState);
  Settings.render(appState);
  if (appState.state.contextWindow && !appState.meter.window) {
    appState.meter.window = appState.state.contextWindow;
  }
  setMode(appState.state.mode === "plan" ? "plan" : "build", false);
  StatusBar.renderMeter(appState);
  Settings.renderCatalogInfo(appState.state, appState.providersInfo);
  return appState.state;
}

/* ----------------------------------------------------------------- sessions */

export async function loadSessions() {
  appState.sessions = (await api("/api/sessions")) || [];
  Sidebar.fillSessionSelect(appState);
}

export async function selectSession(id) {
  setSessionId(id);
  store.set(SESSION_KEY, id);
  Sidebar.fillSessionSelect(appState);
  Chat.setTurn(null);
  TodoPanel.resetTodo();
  Chat.clearDirtyBlocks();
  Approval.approvals.clear();
  setAppStreaming(false);
  StatusBar.setStreaming(false);
  const messages = Chat.messagesEl();
  if (messages) messages.textContent = "";
  TodoPanel.resetTodo();
  resetMeterState();
  StatusBar.renderMeter(appState);

  const data = await api(`/api/sessions/${encodeURIComponent(id)}`);
  const msgs = (data && data.messages) || [];
  let shown = 0;
  for (const [i, m] of msgs.entries()) {
    if (m.role === "tool") continue;
    const next = msgs[i + 1];
    const results =
      next && next.role === "tool"
        ? new Map((next.results || []).map((r) => [String(r.id), r]))
        : null;
    Chat.renderStoredMessage(m, results);
    shown++;
  }
  if (!shown && messages) {
    messages.appendChild(el("p", "empty muted", t("chat.empty")));
  }
  startSessionStream(id);
  Chat.scrollToBottom(true);
}

export async function newSession() {
  const created = await api("/api/sessions", { method: "POST" });
  await loadSessions();
  const id = (created && created.id) || (appState.sessions[0] && appState.sessions[0].id);
  if (!id) throw new Error("Could not create a session");
  await selectSession(id);
  const input = $("composer-input");
  if (input) input.focus();
}

export async function deleteSession() {
  if (!appState.sessionId) return;
  const current = appState.sessions.find((s) => s.id === appState.sessionId);
  const label = current ? Sidebar.sessionLabel(current) : appState.sessionId;
  if (!confirm(t("chat.deleteConfirm", { name: label }))) return;
  closeStream();
  await api(`/api/sessions/${encodeURIComponent(appState.sessionId)}`, { method: "DELETE" });
  setSessionId(null);
  await loadSessions();
  if (!appState.sessions.length) await newSession();
  else await selectSession(appState.sessions[0].id);
  toast(t("chat.deleted"));
}

export async function undoSessionTurn() {
  if (!appState.sessionId) return;
  try {
    const res = await api(`/api/sessions/${encodeURIComponent(appState.sessionId)}/undo`, { method: "POST" });
    if (res && res.ok) {
      toast(t("chat.undone", { count: res.reverted ? res.reverted.length : 0 }));
    } else if (res && res.conflict) {
      toast(t("chat.undoConflict"), "warn");
    } else {
      toast(res && res.message ? res.message : t("chat.undoNothing"), "warn");
    }
  } catch (err) {
    fail(err);
  }
}

export async function redoSessionTurn() {
  if (!appState.sessionId) return;
  try {
    const res = await api(`/api/sessions/${encodeURIComponent(appState.sessionId)}/redo`, { method: "POST" });
    if (res && res.ok) {
      toast(t("chat.redone", { count: res.reapplied ? res.reapplied.length : 0 }));
    } else if (res && res.conflict) {
      toast(t("chat.undoConflict"), "warn");
    } else {
      toast(res && res.message ? res.message : t("chat.redoNothing"), "warn");
    }
  } catch (err) {
    fail(err);
  }
}

/* ------------------------------------------------------------- stream handler */

function startSessionStream(id) {
  openStream(id, {
    onOpen: () => StatusBar.setStatus(appState.streaming ? Chat.BUSY() : ""),
    onMessage: (ev) => handleEvent(ev),
    onError: async (es) => {
      if (es.readyState === EventSource.CONNECTING) {
        StatusBar.setStatus(t("chat.reconnecting"));
        return;
      }
      StatusBar.setStatus(t("chat.disconnected"));
      try { await api("/api/state"); } catch {}
    },
  });
}

export function handleEvent(ev) {
  if (!ev || typeof ev.type !== "string") return;
  if (appState.streaming) StatusBar.setStatus(Chat.BUSY());

  switch (ev.type) {
    case "text_delta":
      if (!appState.streaming) {
        setAppStreaming(true);
        StatusBar.setStreaming(true);
      }
      Chat.appendDelta(ev.text || "", ev);
      break;
    case "reasoning_delta":
      if (!appState.streaming) {
        setAppStreaming(true);
        StatusBar.setStreaming(true);
      }
      if (!ev.subagent) Chat.appendReasoning(ev.text || "");
      break;
    case "assistant_end": {
      const cur = Chat.getTurn();
      if (cur) {
        Chat.flushRender();
        if (cur.reasoning) cur.reasoning.block.open = false;
        cur.text = null;
      }
      break;
    }
    case "tool_start": {
      if (!appState.streaming) {
        setAppStreaming(true);
        StatusBar.setStreaming(true);
      }
      const cur = Chat.ensureTurn();
      const sub = ev.subagent ? cur.subs.get(String(ev.subagent)) : null;
      const handle = ToolCard.toolRow(Chat.hostFor(ev), ev.name, ev.input);
      (sub ? sub.tools : cur.tools).set(String(ev.id), handle);
      (sub || cur).text = null;
      Chat.scrollToBottom();
      break;
    }
    case "tool_end": {
      const cur = Chat.ensureTurn();
      const sub = ev.subagent ? cur.subs.get(String(ev.subagent)) : null;
      const bag = sub ? sub.tools : cur.tools;
      let handle = bag.get(String(ev.id));
      if (!handle) {
        handle = ToolCard.toolRow(Chat.hostFor(ev), ev.name, ev.input);
        bag.set(String(ev.id), handle);
        (sub || cur).text = null;
      }
      ToolCard.finishToolRow(handle, ev.ok !== false, ev.output);
      Chat.scrollToBottom();
      break;
    }
    case "subagent_start":
      if (!appState.streaming) {
        setAppStreaming(true);
        StatusBar.setStreaming(true);
      }
      ToolCard.subagentBlock(ev, Chat.ensureTurn, Chat.scrollToBottom);
      break;
    case "subagent_end": {
      const cur = Chat.ensureTurn();
      const sub = cur.subs.get(String(ev.id));
      if (sub) {
        sub.badge.textContent = ev.ok ? t("tool.ok") : t("tool.error");
        sub.badge.classList.add(ev.ok ? "ok" : "bad");
        if (!ev.ok) sub.block.classList.add("bad");
        sub.block.open = false;
      }
      cur.text = null;
      break;
    }
    case "compacting":
      Chat.noteLine(t("chat.compacting"), "info", ev);
      break;
    case "compacted":
      Chat.noteLine(t("chat.compacted", { before: (ev.before), after: (ev.after) }), "info", ev);
      break;
    case "approval_request":
      Approval.approvalCard(ev, {
        messageHost: Chat.messageHost,
        scrollToBottom: Chat.scrollToBottom,
      });
      break;
    case "approval_closed":
      Approval.closeApproval(ev.id, ev.outcome);
      break;
    case "tool_note":
      Chat.noteLine(ev.text || "", "warn", ev);
      break;
    case "todo":
      TodoPanel.renderTodo(ev.items || [], $("pinned-todo-container") || Chat.messageHost());
      break;
    case "title":
      if (ev.title && appState.sessionId) {
        const s = appState.sessions.find((x) => x.id === appState.sessionId);
        if (s && s.title !== ev.title) {
          s.title = ev.title;
          Sidebar.fillSessionSelect(appState);
        }
      }
      break;
    case "usage": {
      updateSpentUsage(ev);
      StatusBar.renderMeter(appState);
      const bits = [t("chat.tokens", { in: ev.input ?? 0, out: ev.output ?? 0 })];
      if (ev.cacheRead) bits.push(t("chat.cacheHit", { n: ev.cacheRead }));
      if (typeof ev.cost === "number" && ev.cost > 0) bits.push(`$${ev.cost.toFixed(4)}`);
      Chat.footerOf(Chat.ensureTurn()).textContent = bits.join(" \u00b7 ");
      break;
    }
    case "done": {
      const odd = ev.stopReason && !["end_turn", "stop", "done"].includes(ev.stopReason);
      const turn = Chat.getTurn();
      if (turn && odd) {
        const f = Chat.footerOf(turn);
        f.textContent = `${f.textContent ? `${f.textContent} \u00b7 ` : ""}${t("chat.stopped", { reason: ev.stopReason })}`;
      }
      Chat.flushRender();
      Chat.setTurn(null);
      setAppStreaming(false);
      StatusBar.setStreaming(false);
      Chat.scrollToBottom();
      loadSessions().catch(() => {});
      break;
    }
    case "budget_warning": {
      const msg = ev.kind === "cost"
        ? `Warning: Reached ${ev.percent}% of session cost limit ($${(ev.current || 0).toFixed(2)} / $${(ev.limit || 0).toFixed(2)})`
        : `Warning: Reached ${ev.percent}% of session token limit (${ev.current || 0} / ${ev.limit || 0})`;
      toast(msg, "warn");
      break;
    }
    case "budget_exceeded": {
      const msg = ev.kind === "cost"
        ? `Budget exceeded: Reached cost limit of $${(ev.limit || 0).toFixed(2)}`
        : `Budget exceeded: Reached token limit of ${ev.limit || 0} tokens`;
      toast(msg, "error");
      break;
    }
    case "error":
      Chat.flushRender();
      Chat.setTurn(null);
      setAppStreaming(false);
      StatusBar.setStreaming(false);
      Chat.errorBubble(ev.message);
      break;
    default:
      break;
  }
}

/* ------------------------------------------------------- settings helpers */

async function loadSettingsData(announce) {
  appState.cfg = await api("/api/config");
  if (!appState.cfg.providers) appState.cfg.providers = {};
  setServerConfig(appState.cfg);
  if (appState.cfg.lang && !store.get(LANG_KEY)) {
    setLang(appState.cfg.lang, {
      persistToServer: false,
      onLangChanged: (val) => {
        redrawDynamicText();
      },
    });
  }
  const ids = Object.keys(appState.cfg.providers);
  appState.provId = appState.cfg.providers[appState.cfg.active] ? appState.cfg.active : ids[0] || null;
  if (!appState.provId) {
    appState.provId = "openai";
    appState.cfg.providers[appState.provId] = { kind: "openai", baseUrl: "", apiKey: "", model: "", models: [] };
  }
  Settings.fillSettings(appState.cfg, appState.provId, appState.lang || "vi");
  Settings.renderCatalogInfo(appState.state, appState.providersInfo);
  appState.settingsLoaded = true;
  if (announce) toast(t("ui.configReloaded"));
}

async function saveSettingsData() {
  Settings.readSettings(appState.cfg, appState.provId);
  try {
    const res = await api("/api/config", { method: "PUT", body: appState.cfg });
    toast(t("ui.savedTo", { path: (res && res.path) || "config" }));
    await refreshState();
    await loadSettingsData(false);
  } catch (err) {
    fail(err);
  }
}

/* --------------------------------------------------------------------- boot */

export async function boot() {
  const gate = $("token-gate");
  const app = $("app");
  if (gate) gate.hidden = true;
  if (app) app.hidden = false;
  try {
    const s = await refreshState();
    appState.sessions = s.sessions || [];
    if (!appState.sessions.length) {
      await api("/api/sessions", { method: "POST" });
      await loadSessions();
    } else {
      Sidebar.fillSessionSelect(appState);
    }
    const want = store.get(SESSION_KEY);
    await selectSession(appState.sessions.some((x) => x.id === want) ? want : appState.sessions[0].id);
    if (!s.providerCount || !s.providerReady) {
      await Wizard.enterWizard({ returnTo: "chat" }, {
        showViewFn: showView,
        loadProvidersFn: () => api("/api/providers"),
      });
    }
  } catch (err) {
    fail(err);
  }
}

/* ------------------------------------------------------------------- wiring */

export function wire() {
  // Token gate
  const tokenForm = $("token-form");
  if (tokenForm) {
    tokenForm.addEventListener("submit", (e) => {
      e.preventDefault();
      const input = $("token-input");
      const val = input ? input.value.trim() : "";
      if (!val) return;
      setToken(val);
      boot();
    });
  }

  // Sidebar events
  Sidebar.bindEvents({
    onSelectSession: (id) => selectSession(id).catch(fail),
    onNewSession: () => newSession().catch(fail),
    onDeleteSession: () => deleteSession().catch(fail),
  });

  // Chat events
  Chat.bindEvents({
    onSend: () => Chat.send({
      sessionId: appState.sessionId,
      mode: appState.mode,
      streaming: appState.streaming,
      setStreamingFn: (on) => {
        setAppStreaming(on);
        StatusBar.setStreaming(on);
      },
    }),
    onAbort: () => Chat.abort(appState.sessionId),
    onToggleMode: () => setMode(appState.mode === "plan" ? "build" : "plan"),
    onOpenSettings: () => switchTab("settings"),
    onUndo: () => undoSessionTurn().catch(fail),
    onRedo: () => redoSessionTurn().catch(fail),
  });

  // Settings events
  Settings.bindEvents({
    onSaveSettings: saveSettingsData,
    onActiveProviderChange: (id) => {
      Settings.readProvider(appState.cfg, appState.provId);
      appState.provId = id;
      Settings.fillProvider(appState.cfg, appState.provId);
    },
    onKeyInput: () => Settings.scheduleKeyDiscovery(appState.provId, appState.cfg),
    onAddProvider: () => {
      Wizard.enterWizard({ returnTo: "settings" }, {
        showViewFn: showView,
        loadProvidersFn: () => api("/api/providers"),
      }).catch(fail);
    },
    onRemoveProvider: () => {
      const remaining = Object.keys(appState.cfg.providers || {}).filter((id) => id !== appState.provId);
      const msg = remaining.length
        ? `Remove provider "${appState.provId}"?`
        : `Remove provider "${appState.provId}"? This is your only provider - you will need to add another before you can chat.`;
      if (!confirm(msg)) return;
      delete appState.cfg.providers[appState.provId];
      if (remaining.length) {
        appState.provId = remaining[0];
      } else {
        appState.provId = "openai";
        appState.cfg.providers[appState.provId] = { kind: "openai", baseUrl: "", apiKey: "", model: "", models: [] };
      }
      appState.cfg.active = appState.provId;
      Settings.fillSettings(appState.cfg, appState.provId, appState.lang || "vi");
      toast(t("ui.removedSaveToPersist"));
    },
    onSaveModelId: () => Settings.saveCurrentModelId(appState.cfg, appState.provId),
    onReloadConfig: () => loadSettingsData(true).catch(fail),
    onLangChange: (val) => setLang(val, {
      onLangChanged: (v, persist) => {
        redrawDynamicText();
        if (persist) {
          api("/api/config", { method: "PUT", body: { ...(appState.serverConfig || {}), lang: v } }).catch(() => {});
          if (appState.serverConfig) appState.serverConfig.lang = v;
        }
      },
    }),
    onModelPickerChange: (e) => {
      if (!e.target.value) return;
      const provModel = $("prov-model");
      if (provModel) provModel.value = e.target.value;
      const testRes = $("provider-test-result");
      if (testRes) testRes.hidden = true;
    },
    onModelInput: () => {
      const sel = $("model-picker");
      const typed = $("prov-model") ? $("prov-model").value.trim() : "";
      if (sel) sel.value = Settings.modelChoices.some((m) => m.id === typed) ? typed : "";
      Settings.renderModelLibrary(Settings.modelChoices, typed, appState.cfg, appState.provId);
    },
    onModelLibrarySearch: () => {
      const typed = $("prov-model") ? $("prov-model").value.trim() : "";
      Settings.renderModelLibrary(Settings.modelChoices, typed, appState.cfg, appState.provId);
    },
    onTestProvider: () => Settings.testActiveProvider(appState.provId),
    onRefreshLive: () => Settings.refreshLiveModels(appState.provId, appState.cfg),
    onDownloadCatalog: () => Settings.downloadCatalog(appState.state, async () => {
      Settings.renderCatalogInfo(appState.state, appState.providersInfo);
      await Settings.fillModelPicker(appState.provId, appState.cfg);
    }),
    onModelSearch: (query) => Settings.scheduleModelSearch(query, (hit) => {
      const note = $("model-search-note");
      if (!hit.known) {
        if (note) {
          note.hidden = false;
          note.textContent =
            `tca does not know the base URL for "${hit.providerName}", so it cannot be selected here. ` +
            `Use "Add provider", choose "Other (OpenAI-compatible)", and paste the base URL - ` +
            `then set the model id to "${hit.model.id}".`;
        }
        return;
      }
      if (note) note.hidden = true;
      if (appState.cfg && appState.cfg.providers && appState.cfg.providers[hit.providerId]) {
        Settings.readProvider(appState.cfg, appState.provId);
        appState.provId = hit.providerId;
        appState.cfg.active = appState.provId;
        appState.cfg.providers[appState.provId].model = hit.model.id;
        Settings.fillSettings(appState.cfg, appState.provId, appState.lang || "vi");
        toast(t("ui.pickedRememberSave", { provider: hit.providerName, model: hit.model.id }));
        return;
      }
      toast(t("ui.finishingSetup", { provider: hit.providerName }));
      Wizard.enterWizard({ returnTo: "settings", providerId: hit.providerId, model: hit.model.id }, {
        showViewFn: showView,
        loadProvidersFn: () => api("/api/providers"),
      }).catch(fail);
    }),
  });

  // Wizard events
  Wizard.bindEvents({
    onSwitchTab: switchTab,
    onFinished: async (target) => {
      await refreshState();
      if (appState.settingsLoaded) await loadSettingsData(false);
    },
  });

  // Tabs events
  const tabChat = $("tab-chat");
  if (tabChat) tabChat.addEventListener("click", () => switchTab("chat"));
  const tabSettings = $("tab-settings");
  if (tabSettings) tabSettings.addEventListener("click", () => switchTab("settings"));

  for (const [i, entry] of TABS.entries()) {
    const tabEl = $(entry.tab);
    if (tabEl) {
      tabEl.addEventListener("keydown", (e) => {
        if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
        e.preventDefault();
        const step = e.key === "ArrowRight" ? 1 : -1;
        const next = TABS[(i + step + TABS.length) % TABS.length];
        const nextEl = $(next.tab);
        if (nextEl) nextEl.focus();
        switchTab(next.name);
      });
    }
  }

  // Visual viewport handling for Android keyboards
  const vv = window.visualViewport;
  if (vv) {
    const sync = () => {
      document.documentElement.style.setProperty("--vvh", `${Math.round(vv.height)}px`);
      document.body.classList.add("has-vvh");
      Chat.autogrow();
    };
    vv.addEventListener("resize", sync);
    sync();
  }

  // Visibility change handling
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible" || !appState.sessionId || !getToken()) return;
    startSessionStream(appState.sessionId);
    refreshState().catch(() => {});
  });
}

/* --------------------------------------------------------------------- main */

(async () => {
  await loadI18n();
  wire();
  applyI18n(document);
  const urlToken = takeTokenFromUrl();
  if (urlToken) setToken(urlToken);
  else setToken(getToken());
  if (getToken()) boot();
  else showGate("");
})();
