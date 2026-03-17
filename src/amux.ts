// amux — agentic mux
//
// Architecture:
//   - One global tmux session ("amux") with its own socket and config.
//   - Each unique cwd maps to a tmux window (tab), named after the directory.
//   - Each named panel is a tmux pane tiled within that window.
//   - `amux watch` shows all windows as tabs, with panes tiled inside.
//
// Primary workflow:
//   1. `run` — execute command, stream output from start, return on completion or timeout
//   2. If timeout: output includes continuation hint with byte offset
//   3. `tail -f -c OFFSET` — resume exactly where run left off

import { existsSync, mkdirSync, statSync, rmSync, openSync, readSync, readFileSync, readdirSync, closeSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join, resolve, dirname, basename } from "path";
import { spawnSync, execFileSync } from "child_process";
import { fileURLToPath } from "url";

// -- errors -------------------------------------------------------------------

export class AmuxError extends Error {
  constructor(message: string) { super(message); this.name = "AmuxError"; }
}
export class TmuxError extends AmuxError {
  constructor(message: string) { super(message); this.name = "TmuxError"; }
}
export class PanelNotFound extends AmuxError {
  constructor(message: string) { super(message); this.name = "PanelNotFound"; }
}
export class InvalidPanelName extends AmuxError {
  constructor(message: string) { super(message); this.name = "InvalidPanelName"; }
}

// -- constants ----------------------------------------------------------------

export const SPECIAL_KEYS: Record<string, string> = {
  Enter: "Enter", Tab: "Tab", Esc: "Escape", BSpace: "BSpace", Space: "Space",
  Up: "Up", Down: "Down", Left: "Left", Right: "Right",
};

export const VALID_PANEL_NAME = /^[a-zA-Z0-9_-]+$/;

// Sentinels emitted by bashrc PROMPT_COMMAND on their own line.
export const SUCCESS_RE = /^SUCCESS$/;
export const FAIL_RE = /^FAIL EXITCODE:(\d+)$/;

// Interactive prompt patterns
export const INTERACTIVE_PROMPT_RE = new RegExp(
  [
    "(?:password|passphrase|passcode)\\s*:\\s*$",
    "\\[y/n\\]\\s*:?\\s*$",
    "\\(y/n\\)\\s*:?\\s*$",
    "\\[yes/no\\]\\s*:?\\s*$",
    "continue\\?\\s*\\[y/n\\]\\s*$",
    "press\\s+(?:enter|return|any\\s+key)",
    "enter\\s+(?:password|passphrase|pin)\\s*:\\s*$",
  ].join("|"),
  "i"
);

export const MAX_TIMEOUT = 300; // 5 minutes absolute cap

// -- configuration ------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname, "..");

export const config = {
  sessionName: "amux",
  socketName: "amux",
  tmuxConf: join(ROOT, "conf", "amux", "tmux.conf"),
  bashRc: join(ROOT, "conf", "amux", "bashrc"),
  logDir: join(homedir(), ".amux", "logs"),
  panelDir: join(homedir(), ".amux", "panels"),
};

function shellCmd(): string {
  return `bash --rcfile ${shellEscape(config.bashRc)} --noprofile`;
}

// -- helpers ------------------------------------------------------------------

function shellEscape(s: string): string {
  if (s === "") return "''";
  if (/^[a-zA-Z0-9_./-]+$/.test(s)) return s;
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

const sleepBuffer = new SharedArrayBuffer(4);
const sleepArray = new Int32Array(sleepBuffer);
function sleepSync(ms: number): void {
  Atomics.wait(sleepArray, 0, 0, ms);
}

function monotonic(): number {
  return performance.now() / 1000;
}

export function clampTimeout(t: number): number {
  return Math.max(0, Math.min(t, MAX_TIMEOUT));
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// -- ANSI stripping -----------------------------------------------------------

export function stripAnsi(text: string): string {
  return text
    .replace(/\x1b\][\s\S]*?(?:\x1b\\|\x07)/g, "")  // OSC
    .replace(/\x1b\[[\d;?]*[A-Za-z]/g, "")            // CSI
    .replace(/\x1b[^[\]]/g, "")                        // two-byte escapes
    .replace(/[\x00-\x08\x0b-\x1f]/g, "");            // control chars
}

// -- line detection -----------------------------------------------------------

/** Parse a sentinel/prompt line. Returns info or false if normal output. */
export function detectEnd(
  line: string,
  panelName: string
): { type: "success" | "fail" | "prompt" | "interactive"; exitCode?: number } | false {
  if (SUCCESS_RE.test(line)) return { type: "success", exitCode: 0 };
  const failMatch = FAIL_RE.exec(line);
  if (failMatch) return { type: "fail", exitCode: parseInt(failMatch[1], 10) };

  // Prompt: "NAME $ " or "NAME [exit N] $ "
  const promptRe = new RegExp(
    `^${escapeRegex(panelName)}\\s+(\\[exit \\d+\\]\\s+)?\\$\\s*$`
  );
  if (promptRe.test(line)) return { type: "prompt" };

  if (INTERACTIVE_PROMPT_RE.test(line)) return { type: "interactive" };
  return false;
}

// Backward compat wrapper
export function detectInputWait(
  line: string,
  panelName: string
): "prompt" | "interactive" | false {
  const r = detectEnd(line, panelName);
  if (!r) return false;
  if (r.type === "interactive") return "interactive";
  return "prompt";
}

// -- panel name validation ----------------------------------------------------

export function validatePanelName(name: string | undefined | null): asserts name is string {
  if (name == null) throw new InvalidPanelName("panel name cannot be nil");
  if (name === "") throw new InvalidPanelName("panel name cannot be empty");
  if (!VALID_PANEL_NAME.test(name))
    throw new InvalidPanelName(`invalid panel name "${name}" — use only [a-zA-Z0-9_-]`);
}

// -- tmux primitives ----------------------------------------------------------

function tmuxBase(): string[] {
  return ["tmux", "-L", config.socketName, "-f", config.tmuxConf];
}

export function socketPath(): string {
  const base = process.env.TMUX_TMPDIR || "/tmp";
  return join(base, `tmux-${process.getuid!()}`, config.socketName);
}

export function serverRunning(): boolean {
  return existsSync(socketPath());
}

export function tmux(args: string[], opts?: { allowFail?: boolean }): string {
  const cmd = tmuxBase();
  const all = [...cmd, ...args];
  const result = spawnSync(all[0], all.slice(1), {
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  });
  const out = (result.stdout ?? "") + (result.stderr ?? "");
  if (result.status === 0 || opts?.allowFail) return out;
  throw new TmuxError(`tmux ${args[0]}: ${out.trim()}`);
}

function reloadConfig(): void {
  if (!serverRunning()) return;
  const all = [...tmuxBase(), "source-file", config.tmuxConf];
  spawnSync(all[0], all.slice(1), { stdio: ["ignore", "ignore", "ignore"] });
}

export function hasSession(): boolean {
  if (!serverRunning()) return false;
  const all = [...tmuxBase(), "has-session", "-t", config.sessionName];
  const result = spawnSync(all[0], all.slice(1), { stdio: ["ignore", "ignore", "ignore"] });
  return result.status === 0;
}

export function ensureSession(): void {
  reloadConfig();
  if (hasSession()) return;
  const tabName = cwdToTabName(process.cwd());
  tmux([
    "new-session", "-d",
    "-s", config.sessionName,
    "-n", tabName,
    "-c", process.cwd(),
    shellCmd(),
  ]);
}

// -- tab (window) management --------------------------------------------------

function cwdToTabName(cwd: string): string {
  const name = basename(resolve(cwd)) || "root";
  return name.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 30);
}

export interface TabInfo {
  windowId: string;
  windowIndex: number;
  windowName: string;
}

export interface PaneInfo {
  paneId: string;
  paneName: string;
  windowId: string;
  windowName: string;
}

function listWindows(): TabInfo[] {
  if (!hasSession()) return [];
  const out = tmux([
    "list-windows", "-t", config.sessionName,
    "-F", "#{window_id}\t#{window_index}\t#{window_name}",
  ], { allowFail: true });
  const tabs: TabInfo[] = [];
  for (const line of out.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [windowId, idx, windowName] = trimmed.split("\t");
    if (!windowId || !idx) continue;
    tabs.push({ windowId, windowIndex: parseInt(idx, 10), windowName: windowName || "" });
  }
  return tabs;
}

// -- pane registry (sidecar files) --------------------------------------------

function panePanePath(name: string): string {
  return join(config.panelDir, `${name}.pane`);
}

function paneTabPath(name: string): string {
  return join(config.panelDir, `${name}.tab`);
}

function savePaneMapping(name: string, paneId: string, tabName: string): void {
  mkdirSync(config.panelDir, { recursive: true });
  writeFileSync(panePanePath(name), paneId);
  writeFileSync(paneTabPath(name), tabName);
}

function loadPaneId(name: string): string | undefined {
  try { return readFileSync(panePanePath(name), "utf-8").trim() || undefined; } catch { return undefined; }
}

function loadPaneTab(name: string): string | undefined {
  try { return readFileSync(paneTabPath(name), "utf-8").trim() || undefined; } catch { return undefined; }
}

function paneAlive(paneId: string): boolean {
  const out = tmux(["list-panes", "-s", "-t", config.sessionName, "-F", "#{pane_id}"], { allowFail: true });
  return out.split("\n").some(l => l.trim() === paneId);
}

function listAllPanes(): PaneInfo[] {
  if (!hasSession()) return [];
  try {
    const files = readdirSync(config.panelDir);
    const panes: PaneInfo[] = [];
    for (const f of files) {
      if (!f.endsWith(".pane")) continue;
      const name = f.slice(0, -5);
      const paneId = loadPaneId(name);
      const tabName = loadPaneTab(name);
      if (!paneId || !tabName) continue;
      if (!paneAlive(paneId)) {
        try { rmSync(panePanePath(name), { force: true }); } catch {}
        try { rmSync(paneTabPath(name), { force: true }); } catch {}
        try { rmSync(panelLogPath(name), { force: true }); } catch {}
        try { rmSync(panelCwdPath(name), { force: true }); } catch {}
        continue;
      }
      panes.push({ paneId, paneName: name, windowId: "", windowName: tabName });
    }
    return panes;
  } catch {
    return [];
  }
}

function ensureTab(cwd: string): TabInfo {
  ensureSession();
  const tabName = cwdToTabName(cwd);
  const windows = listWindows();
  const existing = windows.find(w => w.windowName === tabName);
  if (existing) return existing;
  const out = tmux([
    "new-window", "-d",
    "-t", config.sessionName,
    "-n", tabName,
    "-c", cwd,
    "-P", "-F", "#{window_id}\t#{window_index}",
    shellCmd(),
  ]);
  const parts = out.trim().split("\t");
  return { windowId: parts[0], windowIndex: parseInt(parts[1] || "0", 10), windowName: tabName };
}

function findPane(name: string): PaneInfo | undefined {
  const paneId = loadPaneId(name);
  const tabName = loadPaneTab(name);
  if (!paneId || !tabName) return undefined;
  if (!paneAlive(paneId)) {
    try { rmSync(panePanePath(name), { force: true }); } catch {}
    try { rmSync(paneTabPath(name), { force: true }); } catch {}
    return undefined;
  }
  return { paneId, paneName: name, windowId: "", windowName: tabName };
}

function resolvePane(name: string): PaneInfo {
  const pane = findPane(name);
  if (!pane) throw new PanelNotFound(`panel '${name}' not found`);
  return pane;
}

// -- panel log files ----------------------------------------------------------

export function panelLogPath(name: string): string {
  return join(config.panelDir, `${name}.log`);
}

function panelCwdPath(name: string): string {
  return join(config.panelDir, `${name}.cwd`);
}

export function panelCwd(name: string): string | undefined {
  try {
    return readFileSync(panelCwdPath(name), "utf-8").trim() || undefined;
  } catch { return undefined; }
}

function startPanelLog(paneId: string, name: string): void {
  mkdirSync(config.panelDir, { recursive: true });
  const logPath = panelLogPath(name);
  writeFileSync(logPath, "");
  writeFileSync(panelCwdPath(name), process.cwd());
  tmux(["pipe-pane", "-o", "-t", paneId, `cat >> ${shellEscape(logPath)}`]);
}

// -- panel (pane) creation ----------------------------------------------------

export function ensurePanel(name: string): string {
  validatePanelName(name);

  const existing = findPane(name);
  if (existing) return existing.paneId;

  const cwd = process.cwd();
  const tab = ensureTab(cwd);

  const existingAfter = findPane(name);
  if (existingAfter) return existingAfter.paneId;

  const windowPanes = listAllPanes().filter(p => p.windowId === tab.windowId);
  const defaultPane = windowPanes.length === 1 && !windowPanes[0].paneName
    ? windowPanes[0] : null;

  let paneId: string;

  if (defaultPane) {
    paneId = defaultPane.paneId;
    tmux(["send-keys", "-t", paneId, "-l", "--",
      `export AMUX_PANEL=${shellEscape(name)}; clear`]);
    tmux(["send-keys", "-t", paneId, "Enter"]);
    sleepSync(300);
    tmux(["select-pane", "-t", paneId, "-T", name], { allowFail: true });
  } else {
    const out = tmux([
      "split-window", "-d",
      "-t", tab.windowId,
      "-c", cwd,
      "-e", `AMUX_PANEL=${shellEscape(name)}`,
      "-P", "-F", "#{pane_id}",
      shellCmd(),
    ]);
    paneId = out.trim();
    tmux(["select-pane", "-t", paneId, "-T", name], { allowFail: true });
    tmux(["select-layout", "-t", tab.windowId, "tiled"], { allowFail: true });
  }

  savePaneMapping(name, paneId, tab.windowName);
  startPanelLog(paneId, name);
  return paneId;
}

// -- streaming engine ---------------------------------------------------------
//
// Shared by `run` and `tail --follow`. Reads the panel log file starting at
// `startPos`, emits output lines to stdout (ANSI intact), and stops when:
//   - A completion sentinel (SUCCESS / FAIL EXITCODE:N) or prompt is seen
//   - The timeout deadline is reached
//
// Returns { timedOut, endPos, exitCode }.

export interface StreamResult {
  timedOut: boolean;
  endPos: number;       // byte offset where streaming stopped
  exitCode?: number;    // set when command completed (0=success, N=fail)
}

function streamLog(
  panelName: string,
  startPos: number,
  timeout: number,
): StreamResult {
  const logPath = panelLogPath(panelName);
  let pos = startPos;

  const sigHandler = () => { process.exit(130); };
  process.on("SIGINT", sigHandler);
  process.on("SIGTERM", sigHandler);

  try {
    let deadline = monotonic() + timeout;
    let timedOut = true;
    let exitCode: number | undefined;
    let partial = "";

    const fd = openSync(logPath, "r");
    const buf = Buffer.alloc(65536);
    try {
      while (true) {
        if (monotonic() >= deadline) break;
        let size: number;
        try { size = statSync(logPath).size; } catch { size = 0; }

        if (size > pos) {
          const toRead = Math.min(size - pos, buf.length);
          const bytesRead = readSync(fd, buf, 0, toRead, pos);
          if (bytesRead > 0) {
            pos += bytesRead;
            const text = partial + buf.toString("utf-8", 0, bytesRead);
            const lines = text.split("\n");
            partial = lines.pop()!;

            for (const raw of lines) {
              const clean = stripAnsi(raw).trimEnd();
              const end = detectEnd(clean, panelName);
              if (end) {
                timedOut = false;
                if (end.exitCode !== undefined) exitCode = end.exitCode;
                // Grace period to drain remaining output
                const cap = monotonic() + 0.2;
                if (cap < deadline) deadline = cap;
                continue;
              }
              if (raw) process.stdout.write(raw + "\n");
            }

            // Check partial line for prompt/sentinel
            if (partial) {
              const cleanPartial = stripAnsi(partial).trimEnd();
              const end = detectEnd(cleanPartial, panelName);
              if (end) {
                timedOut = false;
                if (end.exitCode !== undefined) exitCode = end.exitCode;
                const cap = monotonic() + 0.2;
                if (cap < deadline) deadline = cap;
              }
            }
          }
        } else {
          sleepSync(50);
        }
      }
    } finally {
      closeSync(fd);
    }

    // Flush partial
    if (partial) {
      const clean = stripAnsi(partial).trimEnd();
      if (clean && !detectEnd(clean, panelName)) {
        process.stdout.write(partial + "\n");
      }
    }

    return { timedOut, endPos: pos, exitCode };
  } finally {
    process.removeListener("SIGINT", sigHandler);
    process.removeListener("SIGTERM", sigHandler);
  }
}

// -- core API -----------------------------------------------------------------

export interface RunResult {
  timedOut: boolean;
  endPos: number;       // byte offset where output stopped — pass to tail -c
  exitCode?: number;    // set if command completed
}

/**
 * Run a command in a panel. Streams all output from start of the command.
 * Default timeout: 5s, max 300s.
 *
 * If the command completes within timeout, prints SUCCESS or FAIL and returns.
 * If timeout is hit, prints a continuation hint:
 *   ⏳ deadline 5s — continue with: amux_tail(name: "X", follow: true, offset: N)
 */
// Commands that would nest terminal multiplexers inside amux
export const NESTING_RE = /\b(amux|tmux|zellij)\b/i;

export function rejectNesting(command: string): void {
  if (NESTING_RE.test(command)) {
    throw new AmuxError(
      "unnecessary terminal muxer nesting — amux already runs inside tmux. " +
      "Run the underlying command directly."
    );
  }
}

export function run(
  name: string,
  command: string,
  opts?: { timeout?: number }
): RunResult {
  if (!command?.trim()) throw new AmuxError("missing command");
  rejectNesting(command);
  const timeout = clampTimeout(opts?.timeout ?? 5);
  const paneId = ensurePanel(name);

  const logPath = panelLogPath(name);
  // Record log position BEFORE sending the command
  let startPos = 0;
  try { startPos = statSync(logPath).size; } catch {}

  // Send command
  tmux(["send-keys", "-t", paneId, "-l", "--", command]);
  tmux(["send-keys", "-t", paneId, "Enter"]);

  // Stream from start of this command
  const result = streamLog(name, startPos, timeout);

  if (result.timedOut) {
    process.stdout.write(
      `\n⏳ timeout ${timeout}s — continue with:\n` +
      `  amux_tail(name: "${name}", follow: true, offset: ${result.endPos})\n`
    );
  } else if (result.exitCode !== undefined) {
    if (result.exitCode === 0) {
      process.stdout.write(`\nSUCCESS\n`);
    } else {
      process.stdout.write(`\nFAIL EXITCODE:${result.exitCode}\n`);
    }
  }

  return result;
}

export function normalizeKey(token: string): string | undefined {
  const m = token.match(/^C-(.)$/i);
  if (m) return `C-${m[1].toLowerCase()}`;
  return SPECIAL_KEYS[token];
}

/** Send keystrokes to a panel. Returns true if timed out. */
export function sendKeys(
  name: string,
  keys: string[],
  opts?: { timeout?: number }
): boolean {
  const timeout = clampTimeout(opts?.timeout ?? 5);
  const paneId = ensurePanel(name);

  const logPath = panelLogPath(name);
  let startPos = 0;
  try { startPos = statSync(logPath).size; } catch {}

  for (const token of keys) {
    const key = normalizeKey(token);
    if (key) {
      tmux(["send-keys", "-t", paneId, key]);
    } else {
      tmux(["send-keys", "-t", paneId, "-l", "--", token]);
    }
  }

  const result = streamLog(name, startPos, timeout);
  return result.timedOut;
}

/**
 * Tail the panel log.
 *
 * Without --follow: prints last N lines from the log (default 10).
 * With --follow: streams live output until command completes or timeout.
 * With --offset (-c): start reading from byte offset (for continuing after run timeout).
 *
 * Default timeout: 60s, max 300s.
 */
export function tail(
  name: string,
  opts?: { follow?: boolean; lines?: number; timeout?: number; offset?: number }
): RunResult {
  const _follow = opts?.follow ?? false;
  const _lines = opts?.lines ?? 10;
  const _timeout = clampTimeout(opts?.timeout ?? 60);
  const _offset = opts?.offset;

  resolvePane(name); // throws if panel doesn't exist
  const logPath = panelLogPath(name);

  // If offset is given, jump straight to streaming from that position
  if (_offset !== undefined) {
    const result = streamLog(name, _offset, _timeout);
    if (result.timedOut) {
      process.stdout.write(
        `\n⏳ timeout ${_timeout}s — continue with:\n` +
        `  amux_tail(name: "${name}", follow: true, offset: ${result.endPos})\n`
      );
    } else if (result.exitCode !== undefined) {
      if (result.exitCode === 0) {
        process.stdout.write(`\nSUCCESS\n`);
      } else {
        process.stdout.write(`\nFAIL EXITCODE:${result.exitCode}\n`);
      }
    }
    return result;
  }

  // Read tail of log file (last N lines)
  const CHUNK = Math.max(65536, _lines * 512);
  let content = "";
  let fileSize = 0;
  try {
    const fd = openSync(logPath, "r");
    try {
      const st = statSync(logPath);
      fileSize = st.size;
      if (fileSize > 0) {
        const start = Math.max(0, fileSize - CHUNK);
        const buf = Buffer.alloc(Math.min(CHUNK, fileSize));
        readSync(fd, buf, 0, buf.length, start);
        content = buf.toString("utf-8");
      }
    } finally {
      closeSync(fd);
    }
  } catch {
    return { timedOut: false, endPos: 0 };
  }

  const allLines = content.split("\n");
  if (allLines.length > 0 && allLines[allLines.length - 1] === "") allLines.pop();

  // Emit last N lines, filtering sentinels/prompts
  const tailSlice = allLines.slice(-_lines);
  for (const raw of tailSlice) {
    const clean = stripAnsi(raw).trimEnd();
    if (detectEnd(clean, name)) continue;
    if (raw) process.stdout.write(raw + "\n");
  }

  if (!_follow) return { timedOut: false, endPos: fileSize };

  // Follow mode — stream from current end of file
  const result = streamLog(name, fileSize, _timeout);
  if (result.timedOut) {
    process.stdout.write(
      `\n⏳ timeout ${_timeout}s — continue with:\n` +
      `  amux_tail(name: "${name}", follow: true, offset: ${result.endPos})\n`
    );
  } else if (result.exitCode !== undefined) {
    if (result.exitCode === 0) {
      process.stdout.write(`\nSUCCESS\n`);
    } else {
      process.stdout.write(`\nFAIL EXITCODE:${result.exitCode}\n`);
    }
  }
  return result;
}

/** Dump the tmux capture-pane content (raw panel screen). */
export function panelGet(name: string, opts?: { full?: boolean }): string {
  const pane = resolvePane(name);
  const args = ["capture-pane", "-p", "-t", pane.paneId];
  if (opts?.full) args.push("-S", "-");
  const output = tmux(args);
  const lines = output.split("\n");
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
  return lines.length === 0 ? "" : lines.join("\n") + "\n";
}

export function kill(name: string): void {
  const pane = findPane(name);
  if (!pane) return;
  tmux(["kill-pane", "-t", pane.paneId], { allowFail: true });
  try { rmSync(panelLogPath(name), { force: true }); } catch {}
  try { rmSync(panelCwdPath(name), { force: true }); } catch {}
  try { rmSync(panePanePath(name), { force: true }); } catch {}
  try { rmSync(paneTabPath(name), { force: true }); } catch {}
}

export function terminate(): void {
  tmux(["kill-session", "-t", config.sessionName], { allowFail: true });
  try { rmSync(config.panelDir, { recursive: true, force: true }); } catch {}
}

export function watch(opts?: { readonly?: boolean }): never {
  const ro = opts?.readonly ?? false;
  ensureSession();
  selectBestWindow();
  const args = [...tmuxBase(), "attach-session", "-t", config.sessionName];
  if (ro) args.push("-r");
  try {
    execFileSync(args[0], args.slice(1), { stdio: "inherit" });
    process.exit(0);
  } catch (e: any) {
    process.exit(e.status ?? 1);
  }
}

function selectBestWindow(): void {
  const tabName = cwdToTabName(process.cwd());
  const windows = listWindows();
  const match = windows.find(w => w.windowName === tabName);
  if (match) {
    tmux(["select-window", "-t", match.windowId]);
  } else if (windows.length > 0) {
    const best = windows.reduce((a, b) => a.windowIndex > b.windowIndex ? a : b);
    tmux(["select-window", "-t", best.windowId]);
  }
}

export function panels(): PaneInfo[] {
  return listAllPanes().filter(p => p.paneName);
}

export function list(): void {
  const allPanes = panels();
  if (allPanes.length === 0) {
    console.log("no panels");
    return;
  }
  const byTab: Record<string, PaneInfo[]> = {};
  for (const p of allPanes) {
    const tab = p.windowName || "?";
    if (!byTab[tab]) byTab[tab] = [];
    byTab[tab].push(p);
  }
  for (const [tab, panes] of Object.entries(byTab)) {
    console.log(`${tab}/`);
    for (const p of panes) {
      console.log(`  ${p.paneName}\t${p.paneId}`);
    }
  }
}
