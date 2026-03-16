// amux — agentic mux
// Library entrypoint

export {
  // Core API
  shell,
  sendKeys,
  tail,
  kill,
  list,
  watch,
  terminate,

  // Panel management
  ensurePanel,
  findPanel,
  panels,
  windowMap,
  type WindowMeta,

  // Session management
  ensureSession,
  hasSession,
  serverRunning,

  // Configuration
  config,

  // Detection
  detectInputWait,
  normalizeKey,
  validatePanelName,
  stripAnsi,

  // Panel logs
  panelLogPath,
  panelCwd,

  // Low-level
  tmux,
  socketPath,
  saveTimeoutLog,

  // Errors
  AmuxError,
  TmuxError,
  PanelNotFound,
  InvalidPanelName,

  // Constants
  SPECIAL_KEYS,
  VALID_PANEL_NAME,
  INTERACTIVE_PROMPT_RE,
  DONE_SENTINEL_RE,
} from "./amux.ts";
