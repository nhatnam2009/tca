/**
 * Central state store for tca web UI.
 *
 * Rules:
 *   - independent of DOM;
 *   - single source of truth for session, provider, turn, todo and config state;
 *   - components read state and invoke state transitions.
 */

export const appState = {
  state: null, // last /api/state payload
  mode: "build", // "build" | "plan"
  sessions: [],
  sessionId: null,
  streaming: false,
  turn: null, // { bubble, body, text:{node,raw}|null, footer, tools:Map, subs:Map, reasoning:null }
  stick: true, // auto-scroll stickiness
  approvals: new Map(), // approval id -> settle(label)
  todoCard: null,
  todoItems: [],
  spent: { cost: 0, input: 0, output: 0, cacheRead: 0 },
  meter: { used: 0, window: 0 },
  serverConfig: null,
  cfg: null, // working copy of settings config
  provId: null, // provider currently shown in settings
  settingsLoaded: false,
  modelChoices: [],
  providersInfo: null,
  wiz: null, // wizard state draft
};

export function resetMeterState() {
  appState.spent = { cost: 0, input: 0, output: 0, cacheRead: 0 };
  appState.meter = { used: 0, window: (appState.state && appState.state.contextWindow) || 0 };
}

export function updateSpentUsage(ev) {
  appState.spent.input += ev.input || 0;
  appState.spent.output += ev.output || 0;
  appState.spent.cacheRead += ev.cacheRead || 0;
  if (typeof ev.cost === "number") appState.spent.cost += ev.cost;
  if (ev.contextWindow) appState.meter.window = ev.contextWindow;
  if (ev.contextUsed) appState.meter.used = ev.contextUsed;
}

export function setAppMode(mode) {
  appState.mode = mode === "plan" ? "plan" : "build";
}

export function setAppStreaming(streaming) {
  appState.streaming = Boolean(streaming);
}

export function setSessionId(id) {
  appState.sessionId = id;
}

export function setSessions(sessions) {
  appState.sessions = Array.isArray(sessions) ? sessions : [];
}

export function setServerConfig(config) {
  appState.serverConfig = config;
}

export function setSettingsConfig(cfg) {
  appState.cfg = cfg;
}

export function setSettingsProviderId(id) {
  appState.provId = id;
}

export function setWizardState(wiz) {
  appState.wiz = wiz;
}
