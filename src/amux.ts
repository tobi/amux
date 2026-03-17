// amux — agentic mux
//
// Architecture:
//   - One global tmux session ("amux") with its own socket and config.
//   - Each unique cwd maps to a tmux window (tab), named after the directory.
//   - Each named panel is a tmux pane tiled within that window.
//
// Library API is fully async — safe for embedding in event loops (pi extensions).
// CLI bin wraps with top-level await.

import { existsSync, mkdirSync, statSync, rmSync, openSync, readSync, readFileSync,
  readdirSync, closeSync, writeFileSync, watch as fsWatch } from "fs";
import { homedir } from "os";
import { join, resolve, dirname, basename } from "path";
import { spawn, execFileSync } from "child_process";
import { fileURLToPath } from "url";
import type { FSWatcher } from "fs";

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
export const SUCCESS_RE = /^SUCCESS$/;
export const FAIL_RE = /^FAIL EXITCODE:(\d+)$/;

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

export const MAX_TIMEOUT = 300;
export const NESTING_RE = /\b(amux|tmux|zellij)\b/i;

export function rejectNesting(command: string): void {
  if (NESTING_RE.test(command)) {
    throw new AmuxError(
      "unnecessary terminal muxer nesting — amux already runs inside tmux. " +
      "Run the underlying command directly."
    );
  }
}

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

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
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
    .replace(/\x1b\][\s\S]*?(?:\x1b\\|\x07)/g, "")
    .replace(/\x1b\[[\d;?]*[A-Za-z]/g, "")
    .replace(/\x1b[^[\]]/g, "")
    .replace(/[\x00-\x08\x0b-\x1f]/g, "");
}

// -- line detection -----------------------------------------------------------

export const PROMPT_STR = "amux ready $ ";
export const PROMPT_RE = /^amux ready \$\s*$/;
export const PROMPT_LINE_RE = /^amux ready \$ /;  // matches prompt + command echo

/** Is this line amux shell noise that should be hidden from the LLM? */
export function isShellNoise(line: string): boolean {
  const clean = stripAnsi(line).trimEnd();
  if (!clean) return false;
  if (PROMPT_RE.test(clean)) return true;        // bare prompt: "amux ready $"
  if (PROMPT_LINE_RE.test(clean)) return true;    // command echo: "amux ready $ cmd..."
  if (SUCCESS_RE.test(clean)) return true;        // sentinel
  if (FAIL_RE.test(clean)) return true;           // sentinel
  if (/^\[\?2004[hl]/.test(clean)) return true;   // bracketed paste mode toggle
  return false;
}

export function detectEnd(
  line: string,
  _panelName?: string
): { type: "success" | "fail" | "prompt" | "interactive"; exitCode?: number } | false {
  if (SUCCESS_RE.test(line)) return { type: "success", exitCode: 0 };
  const failMatch = FAIL_RE.exec(line);
  if (failMatch) return { type: "fail", exitCode: parseInt(failMatch[1], 10) };
  if (PROMPT_RE.test(line)) return { type: "prompt" };
  if (INTERACTIVE_PROMPT_RE.test(line)) return { type: "interactive" };
  return false;
}

export function detectInputWait(
  line: string, panelName?: string
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

// -- async tmux ---------------------------------------------------------------

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

export function tmux(args: string[], opts?: { allowFail?: boolean }): Promise<string> {
  return new Promise((resolve, reject) => {
    const cmd = tmuxBase();
    const all = [...cmd, ...args];
    const child = spawn(all[0], all.slice(1), { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
    child.on("close", (code) => {
      const out = stdout + stderr;
      if (code === 0 || opts?.allowFail) resolve(out);
      else reject(new TmuxError(`tmux ${args[0]}: ${out.trim()}`));
    });
    child.on("error", (err) => {
      if (opts?.allowFail) resolve("");
      else reject(new TmuxError(`tmux ${args[0]}: ${err.message}`));
    });
  });
}

async function reloadConfig(): Promise<void> {
  if (!serverRunning()) return;
  await tmux(["source-file", config.tmuxConf], { allowFail: true });
}

export async function hasSession(): Promise<boolean> {
  if (!serverRunning()) return false;
  try { await tmux(["has-session", "-t", config.sessionName]); return true; }
  catch { return false; }
}

export async function ensureSession(): Promise<void> {
  await reloadConfig();
  if (await hasSession()) return;
  const tabName = cwdToTabName(process.cwd());
  await tmux([
    "new-session", "-d", "-s", config.sessionName, "-n", tabName,
    "-c", process.cwd(), shellCmd(),
  ]);
}

// -- tab (window) management --------------------------------------------------

function cwdToTabName(cwd: string): string {
  const name = basename(resolve(cwd)) || "root";
  return name.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 30);
}

export interface TabInfo { windowId: string; windowIndex: number; windowName: string; }
export interface PaneInfo { paneId: string; paneName: string; windowId: string; windowName: string; }
export interface RunResult { timedOut: boolean; endPos: number; exitCode?: number; aborted?: boolean; }

async function listWindows(): Promise<TabInfo[]> {
  if (!(await hasSession())) return [];
  const out = await tmux([
    "list-windows", "-t", config.sessionName,
    "-F", "#{window_id}\t#{window_index}\t#{window_name}",
  ], { allowFail: true });
  const tabs: TabInfo[] = [];
  for (const line of out.split("\n")) {
    const t = line.trim(); if (!t) continue;
    const [wid, idx, wn] = t.split("\t");
    if (!wid || !idx) continue;
    tabs.push({ windowId: wid, windowIndex: parseInt(idx, 10), windowName: wn || "" });
  }
  return tabs;
}

// -- pane registry (sidecar files) --------------------------------------------

function panePanePath(name: string): string { return join(config.panelDir, `${name}.pane`); }
function paneTabPath(name: string): string { return join(config.panelDir, `${name}.tab`); }

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

async function paneAlive(paneId: string): Promise<boolean> {
  const out = await tmux(["list-panes", "-s", "-t", config.sessionName, "-F", "#{pane_id}"], { allowFail: true });
  return out.split("\n").some(l => l.trim() === paneId);
}

async function listAllPanes(): Promise<PaneInfo[]> {
  if (!(await hasSession())) return [];
  try {
    const files = readdirSync(config.panelDir);
    const panes: PaneInfo[] = [];
    for (const f of files) {
      if (!f.endsWith(".pane")) continue;
      const name = f.slice(0, -5);
      const paneId = loadPaneId(name);
      const tabName = loadPaneTab(name);
      if (!paneId || !tabName) continue;
      if (!(await paneAlive(paneId))) {
        try { rmSync(panePanePath(name), { force: true }); } catch {}
        try { rmSync(paneTabPath(name), { force: true }); } catch {}
        try { rmSync(panelLogPath(name), { force: true }); } catch {}
        try { rmSync(panelCwdPath(name), { force: true }); } catch {}
        continue;
      }
      panes.push({ paneId, paneName: name, windowId: "", windowName: tabName });
    }
    return panes;
  } catch { return []; }
}

async function ensureTab(cwd: string): Promise<TabInfo> {
  await ensureSession();
  const tabName = cwdToTabName(cwd);
  const windows = await listWindows();
  const existing = windows.find(w => w.windowName === tabName);
  if (existing) return existing;
  const out = await tmux([
    "new-window", "-d", "-t", config.sessionName, "-n", tabName,
    "-c", cwd, "-P", "-F", "#{window_id}\t#{window_index}", shellCmd(),
  ]);
  const parts = out.trim().split("\t");
  return { windowId: parts[0], windowIndex: parseInt(parts[1] || "0", 10), windowName: tabName };
}

async function findPane(name: string): Promise<PaneInfo | undefined> {
  const paneId = loadPaneId(name);
  const tabName = loadPaneTab(name);
  if (!paneId || !tabName) return undefined;
  if (!(await paneAlive(paneId))) {
    try { rmSync(panePanePath(name), { force: true }); } catch {}
    try { rmSync(paneTabPath(name), { force: true }); } catch {}
    return undefined;
  }
  return { paneId, paneName: name, windowId: "", windowName: tabName };
}

async function resolvePane(name: string): Promise<PaneInfo> {
  const pane = await findPane(name);
  if (!pane) throw new PanelNotFound(`panel '${name}' not found`);
  return pane;
}

// -- panel log files ----------------------------------------------------------

export function panelLogPath(name: string): string { return join(config.panelDir, `${name}.log`); }
function panelCwdPath(name: string): string { return join(config.panelDir, `${name}.cwd`); }

export function panelCwd(name: string): string | undefined {
  try { return readFileSync(panelCwdPath(name), "utf-8").trim() || undefined; } catch { return undefined; }
}

async function startPanelLog(paneId: string, name: string): Promise<void> {
  mkdirSync(config.panelDir, { recursive: true });
  writeFileSync(panelLogPath(name), "");
  writeFileSync(panelCwdPath(name), process.cwd());
  await tmux(["pipe-pane", "-o", "-t", paneId, `cat >> ${shellEscape(panelLogPath(name))}`]);
}

// -- panel creation -----------------------------------------------------------

export async function ensurePanel(name: string): Promise<string> {
  validatePanelName(name);
  const existing = await findPane(name);
  if (existing) return existing.paneId;

  const cwd = process.cwd();
  const tab = await ensureTab(cwd);
  const existingAfter = await findPane(name);
  if (existingAfter) return existingAfter.paneId;

  const windowPanes = (await listAllPanes()).filter(p => p.windowId === tab.windowId);
  const defaultPane = windowPanes.length === 1 && !windowPanes[0].paneName ? windowPanes[0] : null;

  let paneId: string;
  if (defaultPane) {
    paneId = defaultPane.paneId;
    await tmux(["send-keys", "-t", paneId, "-l", "--", `export AMUX_PANEL=${shellEscape(name)}; clear`]);
    await tmux(["send-keys", "-t", paneId, "Enter"]);
    await sleep(300);
    await tmux(["select-pane", "-t", paneId, "-T", name], { allowFail: true });
  } else {
    const out = await tmux([
      "split-window", "-d", "-t", tab.windowId, "-c", cwd,
      "-e", `AMUX_PANEL=${shellEscape(name)}`,
      "-P", "-F", "#{pane_id}", shellCmd(),
    ]);
    paneId = out.trim();
    await tmux(["select-pane", "-t", paneId, "-T", name], { allowFail: true });
    await tmux(["select-layout", "-t", tab.windowId, "tiled"], { allowFail: true });
  }

  savePaneMapping(name, paneId, tab.windowName);
  await startPanelLog(paneId, name);
  return paneId;
}

// -- async streaming engine ---------------------------------------------------

/**
 * Stream the panel log from startPos until sentinel/prompt or timeout.
 * Uses fs.watch + polling. Fully async — never blocks the event loop.
 * onLine callback receives each output line (ANSI intact).
 */
export async function streamLog(
  panelName: string,
  startPos: number,
  timeout: number,
  onLine?: (line: string) => void,
  signal?: AbortSignal,
  grep?: RegExp,
  /** If set, the first line matching the sent command is skipped (command echo). */
  sentCommand?: string,
): Promise<RunResult> {
  const logPath = panelLogPath(panelName);
  let pos = startPos;
  let partial = "";
  let timedOut = true;
  let exitCode: number | undefined;
  let aborted = false;

  const rawEmit = onLine || ((line: string) => { process.stdout.write(line + "\n"); });
  /** Strip shell bookkeeping sequences but keep other ANSI (colors etc). */
  function cleanLine(line: string): string {
    return line
      .replace(/\x1b\[\?2004[hl]/g, "")  // bracketed paste mode
      .replace(/\r/g, "");                // carriage returns
  }
  const emit = grep
    ? (line: string) => { const cl = cleanLine(line); if (cl && grep.test(stripAnsi(cl))) rawEmit(cl); }
    : (line: string) => { const cl = cleanLine(line); if (cl) rawEmit(cl); };
  let commandEchoSkipped = !sentCommand; // true if no command to skip

  return new Promise<RunResult>((resolve) => {
    let watcher: FSWatcher | null = null;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
    let graceTimer: ReturnType<typeof setTimeout> | null = null;
    let done = false;

    function cleanup(): void {
      if (watcher) { watcher.close(); watcher = null; }
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
      if (deadlineTimer) { clearTimeout(deadlineTimer); deadlineTimer = null; }
      if (graceTimer) { clearTimeout(graceTimer); graceTimer = null; }
    }

    function finish(): void {
      if (done) return;
      done = true;
      cleanup();
      if (partial) {
        const clean = stripAnsi(partial).trimEnd();
        if (clean && !detectEnd(clean, panelName) && !isShellNoise(partial)) emit(partial);
      }
      resolve({ timedOut, endPos: pos, exitCode, aborted });
    }

    // Abort on signal
    if (signal) {
      if (signal.aborted) { aborted = true; timedOut = false; finish(); return; }
      signal.addEventListener("abort", () => { aborted = true; timedOut = false; finish(); }, { once: true });
    }

    function processNewData(): void {
      if (done) return;
      let size: number;
      try { size = statSync(logPath).size; } catch { return; }
      if (size <= pos) return;

      const fd = openSync(logPath, "r");
      try {
        const toRead = Math.min(size - pos, 65536);
        const buf = Buffer.alloc(toRead);
        const bytesRead = readSync(fd, buf, 0, toRead, pos);
        if (bytesRead <= 0) return;
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
            if (!graceTimer) graceTimer = setTimeout(finish, 200);
            continue;
          }
          if (isShellNoise(raw)) continue;
          // Skip the first line that matches the sent command (command echo)
          if (!commandEchoSkipped && sentCommand) {
            if (clean === sentCommand || clean.endsWith(sentCommand)) {
              commandEchoSkipped = true;
              continue;
            }
          }
          if (raw) emit(raw);
        }

        if (partial && !graceTimer) {
          const cleanP = stripAnsi(partial).trimEnd();
          const end = detectEnd(cleanP, panelName);
          if (end) {
            timedOut = false;
            if (end.exitCode !== undefined) exitCode = end.exitCode;
            graceTimer = setTimeout(finish, 200);
          }
        }
      } finally {
        closeSync(fd);
      }
    }

    // Watch for log file changes
    try {
      mkdirSync(config.panelDir, { recursive: true });
      watcher = fsWatch(logPath, () => processNewData());
      watcher.on("error", () => {});
    } catch {
      try {
        watcher = fsWatch(config.panelDir, (_ev, f) => {
          if (f === `${panelName}.log`) processNewData();
        });
        watcher.on("error", () => {});
      } catch {}
    }

    // Poll as fallback
    pollTimer = setInterval(processNewData, 100);

    // Hard deadline
    deadlineTimer = setTimeout(finish, timeout * 1000);

    // Initial check
    processNewData();
  });
}

// -- core API (all async) -----------------------------------------------------

/** Check if the panel's shell is at a prompt (idle). */
async function panelIsIdle(paneId: string): Promise<boolean> {
  const screen = await tmux(["capture-pane", "-p", "-t", paneId], { allowFail: true });
  const lines = screen.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i].trim();
    if (trimmed) return PROMPT_RE.test(trimmed);
  }
  return true; // empty screen = fresh panel, idle
}

export async function run(
  name: string,
  command: string,
  opts?: { timeout?: number; onLine?: (line: string) => void; signal?: AbortSignal; skipNestingCheck?: boolean; force?: boolean }
): Promise<RunResult> {
  if (!command?.trim()) throw new AmuxError("missing command");
  if (!opts?.skipNestingCheck) rejectNesting(command);
  const timeout = clampTimeout(opts?.timeout ?? 5);
  let paneId = await ensurePanel(name);

  // Check if panel is busy (command already running)
  if (!(await panelIsIdle(paneId))) {
    if (!opts?.force) {
      throw new AmuxError(
        `panel '${name}' is busy — a command is already running.\n` +
        `Use force: true, or send Ctrl-C first: amux_send_keys(name: "${name}", keys: ["C-c"])`
      );
    }
    // Force mode: try C-c first, then kill+recreate if needed
    await tmux(["send-keys", "-t", paneId, "C-c"]);
    await sleep(500);
    if (!(await panelIsIdle(paneId))) {
      await tmux(["send-keys", "-t", paneId, "C-c"]);
      await sleep(500);
    }
    if (!(await panelIsIdle(paneId))) {
      // C-c didn't work — kill and recreate
      await kill(name);
      await sleep(300);
      paneId = await ensurePanel(name);
      await sleep(500); // wait for shell init
    }
  }

  let startPos = 0;
  try { startPos = statSync(panelLogPath(name)).size; } catch {}

  await tmux(["send-keys", "-t", paneId, "-l", "--", command]);
  await tmux(["send-keys", "-t", paneId, "Enter"]);

  const result = await streamLog(name, startPos, timeout, opts?.onLine, opts?.signal, undefined, command);

  if (!opts?.onLine) {
    if (result.timedOut) {
      process.stdout.write(
        `\n⏳ timeout ${timeout}s — continue with:\n` +
        `  amux_tail(name: "${name}", follow: true, offset: ${result.endPos})\n`
      );
    } else if (result.exitCode !== undefined) {
      process.stdout.write(result.exitCode === 0 ? `\nSUCCESS\n` : `\nFAIL EXITCODE:${result.exitCode}\n`);
    }
  }
  return result;
}

export function normalizeKey(token: string): string | undefined {
  const m = token.match(/^C-(.)$/i);
  if (m) return `C-${m[1].toLowerCase()}`;
  return SPECIAL_KEYS[token];
}

export async function sendKeys(
  name: string, keys: string[], opts?: { timeout?: number }
): Promise<RunResult> {
  const timeout = clampTimeout(opts?.timeout ?? 5);
  const paneId = await ensurePanel(name);
  let startPos = 0;
  try { startPos = statSync(panelLogPath(name)).size; } catch {}

  for (const token of keys) {
    const key = normalizeKey(token);
    if (key) await tmux(["send-keys", "-t", paneId, key]);
    else await tmux(["send-keys", "-t", paneId, "-l", "--", token]);
  }

  return streamLog(name, startPos, timeout);
}

export async function tail(
  name: string,
  opts?: { follow?: boolean; lines?: number; timeout?: number; offset?: number; onLine?: (line: string) => void; signal?: AbortSignal; grep?: RegExp }
): Promise<RunResult> {
  const _follow = opts?.follow ?? false;
  const _lines = opts?.lines ?? 10;
  const _timeout = clampTimeout(opts?.timeout ?? 60);
  const _offset = opts?.offset;
  const _grep = opts?.grep;
  const rawEmit = opts?.onLine || ((line: string) => { process.stdout.write(line + "\n"); });
  const emit = _grep
    ? (line: string) => { if (_grep.test(stripAnsi(line))) rawEmit(line); }
    : rawEmit;

  await resolvePane(name);
  const logPath = panelLogPath(name);

  // Offset mode — jump straight to streaming from that position
  if (_offset !== undefined) {
    const result = await streamLog(name, _offset, _timeout, opts?.onLine, opts?.signal, _grep);
    if (!opts?.onLine) {
      if (result.timedOut) {
        process.stdout.write(
          `\n⏳ timeout ${_timeout}s — continue with:\n` +
          `  amux_tail(name: "${name}", follow: true, offset: ${result.endPos})\n`
        );
      } else if (result.exitCode !== undefined) {
        process.stdout.write(result.exitCode === 0 ? `\nSUCCESS\n` : `\nFAIL EXITCODE:${result.exitCode}\n`);
      }
    }
    return result;
  }

  // Read last N lines
  const CHUNK = Math.max(65536, _lines * 512);
  let content = "";
  let fileSize = 0;
  try {
    const fd = openSync(logPath, "r");
    try {
      fileSize = statSync(logPath).size;
      if (fileSize > 0) {
        const start = Math.max(0, fileSize - CHUNK);
        const buf = Buffer.alloc(Math.min(CHUNK, fileSize));
        readSync(fd, buf, 0, buf.length, start);
        content = buf.toString("utf-8");
      }
    } finally { closeSync(fd); }
  } catch { return { timedOut: false, endPos: 0 }; }

  const allLines = content.split("\n");
  if (allLines.length > 0 && allLines[allLines.length - 1] === "") allLines.pop();

  // Find last prompt line (excluding the very last line which might be a current prompt).
  // Only show output after it — skip previous commands' output.
  let startIdx = 0;
  for (let i = allLines.length - 2; i >= 0; i--) {
    const clean = stripAnsi(allLines[i]).trimEnd();
    if (PROMPT_LINE_RE.test(clean) || PROMPT_RE.test(clean)) {
      startIdx = i + 1; // skip the prompt itself, show from next line
      break;
    }
  }

  const relevant = allLines.slice(startIdx);
  for (const raw of relevant.slice(-_lines)) {
    if (isShellNoise(raw)) continue;
    const cl = raw.replace(/\x1b\[\?2004[hl]/g, "").replace(/\r/g, "");
    if (cl) emit(cl);
  }

  if (!_follow) return { timedOut: false, endPos: fileSize };

  // Follow mode
  const result = await streamLog(name, fileSize, _timeout, opts?.onLine, opts?.signal, _grep);
  if (!opts?.onLine) {
    if (result.timedOut) {
      process.stdout.write(
        `\n⏳ timeout ${_timeout}s — continue with:\n` +
        `  amux_tail(name: "${name}", follow: true, offset: ${result.endPos})\n`
      );
    } else if (result.exitCode !== undefined) {
      process.stdout.write(result.exitCode === 0 ? `\nSUCCESS\n` : `\nFAIL EXITCODE:${result.exitCode}\n`);
    }
  }
  return result;
}

export async function panelGet(name: string, opts?: { full?: boolean }): Promise<string> {
  const pane = await resolvePane(name);
  const args = ["capture-pane", "-p", "-t", pane.paneId];
  if (opts?.full) args.push("-S", "-");
  const output = await tmux(args);
  const lines = output.split("\n");
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
  return lines.length === 0 ? "" : lines.join("\n") + "\n";
}

export async function kill(name: string): Promise<void> {
  const pane = await findPane(name);
  if (!pane) return;
  await tmux(["kill-pane", "-t", pane.paneId], { allowFail: true });
  for (const p of [panelLogPath(name), panelCwdPath(name), panePanePath(name), paneTabPath(name)]) {
    try { rmSync(p, { force: true }); } catch {}
  }
}

export async function terminate(): Promise<void> {
  await tmux(["kill-session", "-t", config.sessionName], { allowFail: true });
  try { rmSync(config.panelDir, { recursive: true, force: true }); } catch {}
}

export function watch(opts?: { readonly?: boolean }): never {
  const ro = opts?.readonly ?? false;
  const args = [...tmuxBase(), "attach-session", "-t", config.sessionName];
  if (ro) args.push("-r");
  try { execFileSync(args[0], args.slice(1), { stdio: "inherit" }); process.exit(0); }
  catch (e: any) { process.exit(e.status ?? 1); }
}

export async function panels(): Promise<PaneInfo[]> {
  return (await listAllPanes()).filter(p => p.paneName);
}

export async function list(): Promise<void> {
  const allPanes = await panels();
  if (allPanes.length === 0) { console.log("no panels"); return; }
  const byTab: Record<string, PaneInfo[]> = {};
  for (const p of allPanes) {
    const tab = p.windowName || "?";
    if (!byTab[tab]) byTab[tab] = [];
    byTab[tab].push(p);
  }
  for (const [tab, pns] of Object.entries(byTab)) {
    console.log(`${tab}/`);
    for (const p of pns) console.log(`  ${p.paneName}\t${p.paneId}`);
  }
}
