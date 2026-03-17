// amux — agentic mux
// Library entrypoint

export {
  // Core API
  run,
  sendKeys,
  tail,
  panelGet,
  kill,
  list,
  watch,
  terminate,

  // Panel management
  ensurePanel,
  panels,

  // Session management
  ensureSession,
  hasSession,
  serverRunning,

  // Configuration
  config,
  MAX_TIMEOUT,

  // Detection
  detectEnd,
  detectInputWait,
  normalizeKey,
  validatePanelName,
  stripAnsi,
  clampTimeout,

  // Panel logs
  panelLogPath,
  panelCwd,

  // Low-level
  tmux,
  socketPath,

  // Errors
  AmuxError,
  TmuxError,
  PanelNotFound,
  InvalidPanelName,

  // Constants
  SPECIAL_KEYS,
  VALID_PANEL_NAME,
  INTERACTIVE_PROMPT_RE,
  SUCCESS_RE,
  FAIL_RE,

  // Types
  type TabInfo,
  type PaneInfo,
  type RunResult,
  type StreamResult,
} from "./amux.ts";
