// amux — agentic mux
//
// All named amux panels live as windows (tabs) inside one global tmux session.
// Each panel name maps to a deterministic tmux window name.
// A dedicated tmux config locks down titles and provides tab switching hotkeys.

import { existsSync, mkdirSync, statSync, rmSync, openSync, readSync, readFileSync, closeSync, writeFileSync } from "fs";
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

// Sentinel emitted by bashrc PROMPT_COMMAND when a command completes.
// Format: AMUX_DONE:<exit_code>:<panel_name>  (on its own line)
export const DONE_SENTINEL_RE = /^AMUX_DONE:(\d+):(.+)$/;

// Interactive prompt patterns — matched against clean line text
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

// -- line detection -----------------------------------------------------------

// Detect if a line indicates the panel is waiting for input.
// Returns the type of wait, or false if output is still streaming.
export function detectInputWait(
  line: string,
  panelName: string
): "prompt" | "interactive" | false {
  // AMUX_DONE sentinel on its own line
  if (DONE_SENTINEL_RE.test(line)) return "prompt";

  // Our amux bashrc prompt: "NAME $ " or "NAME [exit N] $ "
  const promptRe = new RegExp(
    `^${escapeRegex(panelName)}\\s+(\\[exit \\d+\\]\\s+)?\\$\\s*$`
  );
  if (promptRe.test(line)) return "prompt";

  // Generic interactive prompts (password, y/n, etc.)
  if (INTERACTIVE_PROMPT_RE.test(line)) return "interactive";

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
  return text
    // OSC sequences: ESC ] ... (ST | BEL)
    .replace(/\x1b\][\s\S]*?(?:\x1b\\|\x07)/g, "")
    // CSI sequences: ESC [ ... final byte
    .replace(/\x1b\[[\d;?]*[A-Za-z]/g, "")
    // Other two-byte escapes: ESC + single char
    .replace(/\x1b[^[\]]/g, "")
    // Remaining control chars (except newline/tab)
    .replace(/[\x00-\x08\x0b-\x1f]/g, "");
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

/** Path to the cwd sidecar for a panel. */
function panelCwdPath(name: string): string {
  return join(config.panelDir, `${name}.cwd`);
}

/** Read the cwd a panel was created in (or undefined). */
export function panelCwd(name: string): string | undefined {
  try {
    return readFileSync(panelCwdPath(name), "utf-8").trim() || undefined;
  } catch { return undefined; }
}

/** Start persistent pipe-pane logging for a panel. */
function startPanelLog(target: string, name: string): void {
  mkdirSync(config.panelDir, { recursive: true });
  const logPath = panelLogPath(name);
  // Truncate on panel creation — fresh log per panel lifecycle
  writeFileSync(logPath, "");
  // Record cwd at creation time
  writeFileSync(panelCwdPath(name), process.cwd());
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
 *
 * Raw bytes are ANSI-stripped and split into lines. No virtual terminal needed.
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

  const sigHandler = () => { process.exit(130); };
  process.on("SIGINT", sigHandler);
  process.on("SIGTERM", sigHandler);

  try {
    fn();

    let deadline = monotonic() + timeout;
    let timedOut = true;
    let partial = ""; // incomplete line buffer

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
            pos += bytesRead;
            const chunk = buf.toString("utf-8", 0, bytesRead);
            const text = partial + chunk;
            const lines = text.split("\n");

            // Last element is incomplete (no trailing newline yet)
            partial = lines.pop()!;

            for (const raw of lines) {
              const clean = stripAnsi(raw).trimEnd();

              // Check for done sentinel or prompt — don't emit those
              const waiting = detectInputWait(clean, name);
              if (waiting) {
                timedOut = false;
                const grace = waiting === "prompt" ? 0.2 : 0.3;
                const cap = monotonic() + grace;
                if (cap < deadline) deadline = cap;
                continue;
              }

              // Emit raw output (ANSI intact)
              if (raw) process.stdout.write(raw + "\n");
            }

            // Also check the partial line (cursor sitting on prompt)
            if (partial) {
              const cleanPartial = stripAnsi(partial).trimEnd();
              const waiting = detectInputWait(cleanPartial, name);
              if (waiting) {
                timedOut = false;
                const grace = waiting === "prompt" ? 0.2 : 0.3;
                const cap = monotonic() + grace;
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

    // Flush remaining partial line
    if (partial) {
      const clean = stripAnsi(partial).trimEnd();
      if (clean && !detectInputWait(clean, name)) {
        process.stdout.write(partial + "\n");
      }
    }

    return timedOut;
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

/**
 * Tail the panel log file. Streams output to stdout.
 * - follow: keep tailing until timeout or prompt (like `tail -f`)
 * - lines: number of lines to show (default 10)
 * - timeout: max seconds to follow (default 30, only used when follow=true)
 * Returns true if the panel is still running (timed out while following).
 */
export function tail(
  name: string,
  opts?: { follow?: boolean; lines?: number; timeout?: number }
): boolean {
  const _follow = opts?.follow ?? false;
  const _lines = opts?.lines ?? 10;
  const _timeout = opts?.timeout ?? 30;

  resolvePanel(name); // throws if panel doesn't exist
  const logPath = panelLogPath(name);

  // Read the tail of the log file
  const CHUNK = Math.max(65536, _lines * 512);
  let content: string;
  try {
    const fd = openSync(logPath, "r");
    try {
      const st = statSync(logPath);
      const size = st.size;
      if (size === 0) {
        closeSync(fd);
        if (!_follow) return false;
        // fall through to follow mode with pos=0
        content = "";
      } else {
        const start = Math.max(0, size - CHUNK);
        const buf = Buffer.alloc(Math.min(CHUNK, size));
        readSync(fd, buf, 0, buf.length, start);
        content = buf.toString("utf-8");
      }
    } finally {
      closeSync(fd);
    }
  } catch {
    return false;
  }

  // Split, strip ANSI for detection, emit raw tail
  const allLines = content.split("\n");
  // Drop empty trailing element from split
  if (allLines.length > 0 && allLines[allLines.length - 1] === "") allLines.pop();

  // Emit last N lines (skip sentinel/prompt lines)
  const tailLines = allLines.slice(-_lines);
  for (const raw of tailLines) {
    const clean = stripAnsi(raw).trimEnd();
    if (detectInputWait(clean, name)) continue;
    if (raw) process.stdout.write(raw + "\n");
  }

  if (!_follow) return false;

  // Follow mode — tail the log file until sentinel or timeout
  let pos: number;
  try { pos = statSync(logPath).size; } catch { return false; }

  let partial = "";
  const deadline = monotonic() + _timeout;
  let timedOut = true;

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
          const chunk = buf.toString("utf-8", 0, bytesRead);
          const text = partial + chunk;
          const lines = text.split("\n");
          partial = lines.pop()!;

          for (const raw of lines) {
            const clean = stripAnsi(raw).trimEnd();
            const waiting = detectInputWait(clean, name);
            if (waiting) {
              timedOut = false;
              const grace = 0.2;
              const cap = monotonic() + grace;
              if (cap < deadline) { /* let grace period drain */ }
              continue;
            }
            if (raw) process.stdout.write(raw + "\n");
          }

          // Check partial for prompt
          if (partial) {
            const cleanPartial = stripAnsi(partial).trimEnd();
            if (detectInputWait(cleanPartial, name)) {
              timedOut = false;
              break;
            }
          }

          if (!timedOut) break;
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
    if (clean && !detectInputWait(clean, name)) {
      process.stdout.write(partial + "\n");
    }
  }

  return timedOut;
}

export function kill(name: string): void {
  const target = findPanel(name);
  if (!target) return;
  tmux(["kill-window", "-t", target], { allowFail: true });
  // Clean up panel log + cwd sidecar
  try { rmSync(panelLogPath(name), { force: true }); } catch {}
  try { rmSync(panelCwdPath(name), { force: true }); } catch {}
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
