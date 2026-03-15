// amux — agentic mux
//
// All named amux panels live as windows (tabs) inside one global tmux session.
// Each panel name maps to a deterministic tmux window name.
// A dedicated tmux config locks down titles and provides tab switching hotkeys.

import pkg from "@xterm/headless";
const { Terminal } = pkg;
import { existsSync, mkdirSync, statSync, rmSync, openSync, readSync, closeSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join, resolve, dirname } from "path";
import { spawnSync, execFileSync } from "child_process";
import { fileURLToPath } from "url";

// -- errors -------------------------------------------------------------------

export class AmuxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AmuxError";
  }
}

export class TmuxError extends AmuxError {
  constructor(message: string) {
    super(message);
    this.name = "TmuxError";
  }
}

export class PanelNotFound extends AmuxError {
  constructor(message: string) {
    super(message);
    this.name = "PanelNotFound";
  }
}

export class InvalidPanelName extends AmuxError {
  constructor(message: string) {
    super(message);
    this.name = "InvalidPanelName";
  }
}

// -- constants ----------------------------------------------------------------

export const SPECIAL_KEYS: Record<string, string> = {
  Enter: "Enter",
  Tab: "Tab",
  Esc: "Escape",
  BSpace: "BSpace",
  Space: "Space",
  Up: "Up",
  Down: "Down",
  Left: "Left",
  Right: "Right",
};

export const VALID_PANEL_NAME = /^[a-zA-Z0-9_-]+$/;

// Interactive prompt patterns — matched against clean screen text from xterm
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

// -- configuration (overridable for testing) ----------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname, "..");

export const config = {
  sessionName: "amux",
  initPanel: "_amux_init_",
  socketName: "amux",
  tmuxConf: join(ROOT, "conf", "amux", "tmux.conf"),
  bashRc: join(ROOT, "conf", "amux", "bashrc"),
  logDir: join(homedir(), ".amux", "logs"),
  panelDir: join(homedir(), ".amux", "panels"),
};

function shellCmd(): string {
  return `bash --rcfile ${shellEscape(config.bashRc)} --noprofile`;
}

// -- shell escaping -----------------------------------------------------------

function shellEscape(s: string): string {
  if (s === "") return "''";
  if (/^[a-zA-Z0-9_./-]+$/.test(s)) return s;
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

// -- synchronous sleep (node-compatible) --------------------------------------

const sleepBuffer = new SharedArrayBuffer(4);
const sleepArray = new Int32Array(sleepBuffer);

function sleepSync(ms: number): void {
  Atomics.wait(sleepArray, 0, 0, ms);
}

// -- terminal screen reader ---------------------------------------------------
//
// Uses @xterm/headless to maintain a virtual terminal. Raw bytes from tmux
// pipe-pane are fed into xterm, which handles all escape sequences, cursor
// movement, line clearing, etc. We then read the screen buffer to get clean
// text — no regex parsing of raw ANSI needed.

function createScreen(cols = 120, rows = 50): {
  write: (data: Buffer | string) => void;
  cursorLine: () => string;
  screenLines: () => string[];
  dispose: () => void;
} {
  const term = new Terminal({ cols, rows, allowProposedApi: true });
  // Suppress deprecation warning from writeSync
  const origWarn = console.warn;
  console.warn = () => {};
  // @ts-ignore — _core.writeSync is the only synchronous write path
  const writeSync: (data: string) => void = term._core.writeSync.bind(term._core);
  console.warn = origWarn;

  return {
    write(data: Buffer | string) {
      const origWarn = console.warn;
      console.warn = () => {};
      writeSync(typeof data === "string" ? data : data.toString("binary"));
      console.warn = origWarn;
    },
    cursorLine(): string {
      const buf = term.buffer.active;
      return buf.getLine(buf.cursorY)?.translateToString(true) ?? "";
    },
    /** Read all lines from the screen buffer up to and including the cursor row. */
    screenLines(): string[] {
      const buf = term.buffer.active;
      const lines: string[] = [];
      for (let i = 0; i <= buf.cursorY; i++) {
        lines.push(buf.getLine(i)?.translateToString(true) ?? "");
      }
      return lines;
    },
    dispose() {
      term.dispose();
    },
  };
}

// Detect if the current cursor line indicates the panel is waiting for input.
// Returns the type of wait, or false if output is still streaming.
export function detectInputWait(
  cursorLine: string,
  panelName: string
): "prompt" | "interactive" | false {
  // Our amux bashrc prompt: "NAME path $ " or "NAME [exit N] path $ "
  const promptRe = new RegExp(
    `^${escapeRegex(panelName)}\\s+(\\[exit \\d+\\]\\s+)?\\S.*\\$\\s*$`
  );
  if (promptRe.test(cursorLine)) return "prompt";

  // Generic interactive prompts (password, y/n, etc.)
  if (INTERACTIVE_PROMPT_RE.test(cursorLine)) return "interactive";

  return false;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// -- panel name validation ----------------------------------------------------

export function validatePanelName(name: string | undefined | null): asserts name is string {
  if (name == null) throw new InvalidPanelName("panel name cannot be nil");
  if (name === "") throw new InvalidPanelName("panel name cannot be empty");
  if (!VALID_PANEL_NAME.test(name)) {
    throw new InvalidPanelName(
      `invalid panel name "${name}" — use only [a-zA-Z0-9_-]`
    );
  }
  if (name === config.initPanel) {
    throw new InvalidPanelName(`panel name "${name}" is reserved`);
  }
}

// -- tmux primitive -----------------------------------------------------------

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
  spawnSync(all[0], all.slice(1), {
    stdio: ["ignore", "ignore", "ignore"],
  });
}

export function hasSession(): boolean {
  if (!serverRunning()) return false;
  const all = [...tmuxBase(), "has-session", "-t", config.sessionName];
  const result = spawnSync(all[0], all.slice(1), {
    stdio: ["ignore", "ignore", "ignore"],
  });
  return result.status === 0;
}

export function ensureSession(): void {
  reloadConfig();
  if (hasSession()) return;
  tmux([
    "new-session", "-d",
    "-s", config.sessionName,
    "-n", config.initPanel,
    "-c", process.cwd(),
    "-e", `AMUX_PANEL=${config.initPanel}`,
    shellCmd(),
  ]);
}

// -- panel registry -----------------------------------------------------------

export function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[\d;?]*[A-Za-z]/g, "");
}

export interface WindowMeta {
  id: string;
  index: number;
}

export function windowMap(): Record<string, WindowMeta> {
  if (!hasSession()) return {};
  const out = tmux([
    "list-windows", "-t", config.sessionName,
    "-F", "#{window_id} #{window_index} #{window_name}",
  ]);
  const result: Record<string, WindowMeta> = {};
  for (const line of out.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(" ");
    const id = parts[0];
    const indexStr = parts[1];
    const name = parts.slice(2).join(" ").trim();
    if (!id || !indexStr) continue;
    result[name] = { id, index: parseInt(indexStr, 10) };
  }
  return result;
}

export function findPanel(name: string): string | undefined {
  return windowMap()[name]?.id;
}

export function panels(): Record<string, WindowMeta> {
  const wm = windowMap();
  delete wm[config.initPanel];
  return wm;
}

function resolvePanel(name: string): string {
  const id = findPanel(name);
  if (!id) throw new PanelNotFound(`panel '${name}' not found`);
  return id;
}

// -- panel log files ----------------------------------------------------------

/** Path to the persistent output log for a panel. */
export function panelLogPath(name: string): string {
  return join(config.panelDir, `${name}.log`);
}

/** Start persistent pipe-pane logging for a panel. */
function startPanelLog(target: string, name: string): void {
  mkdirSync(config.panelDir, { recursive: true });
  const logPath = panelLogPath(name);
  // Truncate on panel creation — fresh log per panel lifecycle
  writeFileSync(logPath, "");
  tmux([
    "pipe-pane", "-o", "-t", target,
    `cat >> ${shellEscape(logPath)}`,
  ]);
}

// -- lazy panel creation ------------------------------------------------------

export function ensurePanel(name: string): string {
  validatePanelName(name);

  let wm = windowMap();
  if (wm[name]) return wm[name].id;

  ensureSession();

  wm = windowMap();
  if (wm[name]) return wm[name].id;

  const init = wm[config.initPanel];
  const userPanels = Object.keys(wm).filter((k) => k !== config.initPanel);

  let id: string;

  if (init && userPanels.length === 0) {
    tmux(["rename-window", "-t", init.id, name]);
    tmux([
      "send-keys", "-t", init.id, "-l", "--",
      `export AMUX_PANEL=${shellEscape(name)}; clear`,
    ]);
    tmux(["send-keys", "-t", init.id, "Enter"]);
    sleepSync(500);
    id = init.id;
  } else {
    const out = tmux([
      "new-window", "-d",
      "-t", config.sessionName,
      "-n", name,
      "-c", process.cwd(),
      "-e", `AMUX_PANEL=${shellEscape(name)}`,
      "-P", "-F", "#{window_id}",
      shellCmd(),
    ]);
    id = out.trim();
  }

  startPanelLog(id, name);
  return id;
}

// -- streaming infrastructure -------------------------------------------------

let logSeq = 0;

export function saveTimeoutLog(
  rawBytes: Buffer | string,
  panelName: string,
  context: string
): string {
  mkdirSync(config.logDir, { recursive: true });
  const now = new Date();
  const ts =
    String(now.getFullYear()) +
    String(now.getMonth() + 1).padStart(2, "0") +
    String(now.getDate()).padStart(2, "0") +
    "-" +
    String(now.getHours()).padStart(2, "0") +
    String(now.getMinutes()).padStart(2, "0") +
    String(now.getSeconds()).padStart(2, "0");
  const seq = ++logSeq;
  const path = join(config.logDir, `${panelName}-${context}-${ts}-${seq}.raw`);
  writeFileSync(path, rawBytes);
  process.stderr.write(`amux: raw output saved to ${path}\n`);
  process.stderr.write(`amux: inspect with: xxd ${path} | less\n`);
  return path;
}

function monotonic(): number {
  return performance.now() / 1000;
}

/**
 * Tails the persistent panel log file while fn() runs.
 * The log is written by the pipe-pane set up in ensurePanel.
 * Returns true if the stream timed out (panel still producing output).
 */
function streamFor(
  target: string,
  fn: () => void,
  { timeout, panelName }: { timeout?: number; panelName?: string }
): boolean {
  if (!timeout) {
    fn();
    return false;
  }

  const name = panelName || "unknown";
  const logPath = panelLogPath(name);

  // Record current log size so we only read new output
  let pos = 0;
  try { pos = statSync(logPath).size; } catch {}

  // Virtual terminal for clean screen reading
  const screen = createScreen();
  let allData = Buffer.alloc(0);

  const cleanup = () => {
    screen.dispose();
  };

  const sigHandler = () => {
    cleanup();
    process.exit(130);
  };

  process.on("SIGINT", sigHandler);
  process.on("SIGTERM", sigHandler);

  try {
    fn();

    let deadline = monotonic() + timeout;
    let timedOut = true;
    let emittedLines = 0;

    const fd = openSync(logPath, "r");
    const buf = Buffer.alloc(65536);
    try {
      while (true) {
        const t = monotonic();
        if (t >= deadline) break;

        let size: number;
        try { size = statSync(logPath).size; } catch { size = 0; }

        if (size > pos) {
          const toRead = Math.min(size - pos, buf.length);
          const bytesRead = readSync(fd, buf, 0, toRead, pos);
          if (bytesRead > 0) {
            const data = buf.subarray(0, bytesRead);
            pos += bytesRead;
            allData = Buffer.concat([allData, data]);

            // Feed raw bytes into virtual terminal
            screen.write(Buffer.from(data));

            // Read clean screen text and emit only new lines
            const lines = screen.screenLines();
            if (lines.length > emittedLines) {
              const completeEnd = Math.max(emittedLines, lines.length - 1);
              for (let i = emittedLines; i < completeEnd; i++) {
                process.stdout.write(lines[i] + "\n");
              }
              emittedLines = completeEnd;
            }

            // Check if the panel is waiting for input
            const waiting = detectInputWait(screen.cursorLine(), name);
            if (waiting) {
              timedOut = false;
              const grace = waiting === "prompt" ? 0.2 : 0.3;
              const cap = monotonic() + grace;
              if (cap < deadline) deadline = cap;
            }
          }
        } else {
          sleepSync(50);
        }
      }
    } finally {
      closeSync(fd);
    }

    // Flush remaining lines
    const finalLines = screen.screenLines();
    for (let i = emittedLines; i < finalLines.length; i++) {
      const line = finalLines[i];
      if (line.trim()) process.stdout.write(line + "\n");
    }

    if (timedOut && allData.length > 0) {
      saveTimeoutLog(allData, name, "stream");
    }

    cleanup();
    return timedOut;
  } catch (e) {
    cleanup();
    throw e;
  } finally {
    process.removeListener("SIGINT", sigHandler);
    process.removeListener("SIGTERM", sigHandler);
  }
}

// -- core API -----------------------------------------------------------------

/** Returns true if the command timed out (still running). */
export function shell(
  name: string,
  command: string,
  opts?: { timeout?: number }
): boolean {
  if (!command?.trim()) throw new AmuxError("missing command");
  const target = ensurePanel(name);

  return streamFor(
    target,
    () => {
      tmux(["send-keys", "-t", target, "-l", "--", command]);
      tmux(["send-keys", "-t", target, "Enter"]);
    },
    { timeout: opts?.timeout, panelName: name }
  );
}

export function normalizeKey(token: string): string | undefined {
  const m = token.match(/^C-(.)$/i);
  if (m) return `C-${m[1].toLowerCase()}`;
  return SPECIAL_KEYS[token];
}

/** Returns true if the stream timed out. */
export function sendKeys(
  name: string,
  keys: string[],
  opts?: { timeout?: number }
): boolean {
  const target = ensurePanel(name);
  return streamFor(
    target,
    () => {
      for (const token of keys) {
        const key = normalizeKey(token);
        if (key) {
          tmux(["send-keys", "-t", target, key]);
        } else {
          tmux(["send-keys", "-t", target, "-l", "--", token]);
        }
      }
    },
    { timeout: opts?.timeout, panelName: name }
  );
}

export function read(name: string, opts?: { full?: boolean }): string {
  const target = resolvePanel(name);
  const args = ["capture-pane", "-p", "-t", target];
  if (opts?.full) args.push("-S", "-");
  const output = tmux(args);
  const lines = output.split("\n");
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") {
    lines.pop();
  }
  return lines.length === 0 ? "" : lines.join("\n") + "\n";
}

export function kill(name: string): void {
  const target = findPanel(name);
  if (!target) return;
  tmux(["kill-window", "-t", target], { allowFail: true });
  // Clean up panel log
  try { rmSync(panelLogPath(name), { force: true }); } catch {}
}

export function terminate(): void {
  tmux(["kill-session", "-t", config.sessionName], { allowFail: true });
  // Clean up all panel logs
  try { rmSync(config.panelDir, { recursive: true, force: true }); } catch {}
}

export function watch(opts?: { readonly?: boolean }): never {
  const ro = opts?.readonly ?? false;
  ensureSession();
  if (Object.keys(panels()).length === 0) ensurePanel("shell");
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
  const cwd = process.cwd();
  const out = tmux(
    [
      "list-windows", "-t", config.sessionName,
      "-F", "#{window_id} #{window_activity} #{pane_current_path}",
    ],
    { allowFail: true }
  );

  const windows: { id: string; activity: number; path: string }[] = [];
  for (const line of out.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(" ");
    const id = parts[0];
    const actStr = parts[1];
    const path = parts.slice(2).join(" ");
    if (!id || !actStr || !path) continue;
    windows.push({ id, activity: parseInt(actStr, 10), path });
  }

  if (windows.length === 0) return;

  const cwdMatches = windows.filter(
    (w) => w.path.startsWith(cwd) || cwd.startsWith(w.path)
  );
  const pool = cwdMatches.length > 0 ? cwdMatches : windows;
  const best = pool.reduce((a, b) => (a.activity > b.activity ? a : b));
  tmux(["select-window", "-t", best.id]);
}

export function list(): void {
  const p = panels();
  const entries = Object.entries(p);
  if (entries.length === 0) {
    console.log("no panels");
  } else {
    entries
      .sort((a, b) => a[1].index - b[1].index)
      .forEach(([name, meta]) => {
        console.log(`  ${meta.index}\t${name}\t${meta.id}`);
      });
  }
}
