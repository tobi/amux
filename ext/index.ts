/**
 * amux — pi extension
 *
 * Tools for running background tasks in named tmux panels.
 * Status bar shows active panels with pulsing on live output.
 * ⌥1..9 toggles inline trailing widget for panel output (max 6 lines).
 * ⌥k kills the currently trailed panel.
 * Activity detection via fs.watch on ~/.amux/panels/*.log.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { keyHint } from "@mariozechner/pi-coding-agent";
import { Text, Container, matchesKey, Key, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { readdirSync, readFileSync, statSync, watch as fsWatch, mkdirSync, symlinkSync, unlinkSync, existsSync, lstatSync, readlinkSync, realpathSync, openSync, readSync, closeSync, fstatSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { homedir } from "node:os";
// child_process no longer needed — all tool calls use pi.exec via amuxAsync
import { fileURLToPath } from "node:url";
import type { FSWatcher } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PANEL_DIR = join(homedir(), ".amux", "panels");
const HOT_MS = 5000;
const TRAIL_MIN_LINES = 5;
const TRAIL_SCREEN_FRACTION = 0.33;
const TRAIL_REFRESH_MS = 1000;

// ANSI helpers for styling
const BLUE_FG = "\x1b[34m";
const BLUE_BG = "\x1b[44m";
const TEAL_FG = "\x1b[38;2;94;182;176m"; // muted teal
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";

function blueFg(s: string): string { return `${BLUE_FG}${s}${RESET}`; }
function blueBgBlack(s: string): string { return `\x1b[30;1;44m${s}${RESET}`; }
function blueDim(s: string): string { return `${BLUE_FG}${DIM}${s}${RESET}`; }
function gray(s: string): string { return `\x1b[38;5;242m${s}${RESET}`; }
function grayDim(s: string): string { return `\x1b[38;5;239m${s}${RESET}`; }
function teal(s: string): string { return `${TEAL_FG}${s}${RESET}`; }
function tealDim(s: string): string { return `${TEAL_FG}${DIM}${s}${RESET}`; }

function trailLines(): number {
  const rows = process.stdout.rows || 24;
  return Math.max(TRAIL_MIN_LINES, Math.floor(rows * TRAIL_SCREEN_FRACTION));
}

// -- amux CLI helper ----------------------------------------------------------

function amuxBin(): string {
  return join(__dirname, "..", "bin", "amux");
}

/** Check if `amux` is available on PATH (i.e. installed globally). */
function amuxOnPath(): boolean {
  try {
    return existsSync(join(homedir(), ".local", "bin", "amux"))
      || existsSync(join(homedir(), ".local", "share", "bin", "amux"));
  } catch { return false; }
}

/** Async amux CLI call via pi.exec — never blocks the event loop. */
async function amuxAsync(args: string[], timeout = 10): Promise<{ stdout: string; exitCode: number }> {
  const result = await piRef.exec(amuxBin(), args, { timeout: timeout * 1000 });
  return {
    stdout: (result.stdout ?? "") + (result.stderr ?? ""),
    exitCode: result.code ?? 1,
  };
}

/** Fire a command into a panel without waiting — async. */
async function amuxFireAndForget(name: string, command: string): Promise<void> {
  await amuxAsync([name, "run", command, "-t0"], 5);
}

// Sentinels emitted by bashrc PROMPT_COMMAND on their own line
const SUCCESS_RE = /^SUCCESS$/m;
const FAIL_RE = /^FAIL EXITCODE:(\d+)$/m;

/**
 * Wait for a command to complete by watching the panel log for the sentinel.
 * Returns the exit code, or null if timed out (long-running process).
 *
 * Non-blocking — uses async polling with fs.watch for efficiency.
 */
async function waitForDone(
  panelName: string,
  signal?: AbortSignal,
  timeoutMs = 120_000,
): Promise<{ exitCode: number } | null> {
  const logPath = join(PANEL_DIR, `${panelName}.log`);

  // Record position to only scan new bytes
  let pos = 0;
  try { pos = statSync(logPath).size; } catch { return null; }

  const deadline = Date.now() + timeoutMs;

  return new Promise((resolve) => {
    let watcher: FSWatcher | null = null;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let resolved = false;

    function cleanup(): void {
      if (watcher) { watcher.close(); watcher = null; }
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    }

    function done(result: { exitCode: number } | null): void {
      if (resolved) return;
      resolved = true;
      cleanup();
      resolve(result);
    }

    function check(): void {
      if (resolved) return;
      if (signal?.aborted) { done(null); return; }
      if (Date.now() > deadline) { done(null); return; }

      let size: number;
      try { size = statSync(logPath).size; } catch { return; }
      if (size <= pos) return;

      // Read new bytes
      let fd: number;
      try { fd = openSync(logPath, "r"); } catch { return; }
      try {
        const buf = Buffer.alloc(size - pos);
        const bytesRead = readSync(fd, buf, 0, buf.length, pos);
        pos = size;
        if (bytesRead > 0) {
          const chunk = buf.subarray(0, bytesRead).toString("utf-8");
          if (SUCCESS_RE.test(chunk)) {
            done({ exitCode: 0 });
          } else {
            const m = FAIL_RE.exec(chunk);
            if (m) {
              done({ exitCode: parseInt(m[1], 10) });
            }
          }
        }
      } finally {
        closeSync(fd);
      }
    }

    // Watch for file changes
    try {
      watcher = fsWatch(PANEL_DIR, (_ev, f) => {
        if (f === `${panelName}.log`) check();
      });
      watcher.on("error", () => {});
    } catch {}

    // Fallback poll every 500ms in case fs.watch misses events
    pollTimer = setInterval(check, 500);

    // Abort signal
    signal?.addEventListener("abort", () => done(null), { once: true });

    // Initial check — command may have already finished
    check();
  });
}

// -- panel discovery from filesystem ------------------------------------------

interface PanelState {
  name: string;
  hot: boolean;
  lastActivityMs: number;
  cwd: string | undefined;
}

const STALE_MS = 3 * 60 * 1000; // 3 minutes — dim tabs with no recent output
const BLINK_MS = 2000;          // blink for 2s after new output on non-trailed panel

// Track last-seen log size per panel to detect new output
const panelLogSizes: Record<string, number> = {};
// Timestamp of last new-output event per panel (for blink effect)
const panelBlinkUntil: Record<string, number> = {};
// Rolling byte count: [timestamp, bytes][] — recent output volume per panel
const panelOutputLog: Record<string, [number, number][]> = {};
const BURST_WINDOW_MS = 10_000; // 10s window
const BURST_THRESHOLD = 500;    // bytes in window to count as "burst"

function discoverAllPanels(): PanelState[] {
  try {
    const files = readdirSync(PANEL_DIR);
    const now = Date.now();
    const panels: PanelState[] = [];
    for (const f of files) {
      if (!f.endsWith(".log")) continue;
      const name = basename(f, ".log");
      let hot = false;
      let lastActivityMs = 0;
      try {
        const st = statSync(join(PANEL_DIR, f));
        hot = (now - st.mtimeMs) < HOT_MS;
        lastActivityMs = st.mtimeMs;

        // Detect new output → trigger highlight on non-trailed panels
        const prevSize = panelLogSizes[name] ?? st.size;
        const delta = st.size - prevSize;
        if (delta > 0) {
          // Record output volume
          if (!panelOutputLog[name]) panelOutputLog[name] = [];
          panelOutputLog[name].push([now, delta]);
          // Prune old entries
          panelOutputLog[name] = panelOutputLog[name].filter(([t]) => now - t < BURST_WINDOW_MS);

          if (name !== trailPanel) {
            panelBlinkUntil[name] = now + BLINK_MS;
          }
        }
        panelLogSizes[name] = st.size;
      } catch {}
      let cwd: string | undefined;
      try {
        cwd = readFileSync(join(PANEL_DIR, `${name}.cwd`), "utf-8").trim() || undefined;
      } catch {}
      panels.push({ name, hot, lastActivityMs, cwd });
    }
    return panels.sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

function normalizePath(p: string): string {
  try { return realpathSync(p); } catch { return p; }
}

interface ScopedPanels {
  local: PanelState[];
  others: PanelState[];
}

function scopePanels(cwd: string): ScopedPanels {
  const all = discoverAllPanels();
  const norm = normalizePath(cwd);
  const local: PanelState[] = [];
  const others: PanelState[] = [];
  for (const p of all) {
    if (p.cwd && normalizePath(p.cwd) === norm) {
      local.push(p);
    } else {
      others.push(p);
    }
  }
  return { local, others };
}

// -- watcher ------------------------------------------------------------------

let lastCtx: ExtensionContext | null = null;
let dirWatcher: FSWatcher | null = null;
let cooldownTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleUpdate(): void {
  if (cooldownTimer) return;
  refreshTabBar();
  cooldownTimer = setTimeout(() => { cooldownTimer = null; refreshTabBar(); }, 500);
}

function startWatching(ctx: ExtensionContext): void {
  lastCtx = ctx;
  stopWatching();
  mkdirSync(PANEL_DIR, { recursive: true });
  try {
    dirWatcher = fsWatch(PANEL_DIR, (_ev, f) => {
      if (f && f.endsWith(".log")) scheduleUpdate();
    });
    dirWatcher.on("error", () => {});
  } catch {}
}

function stopWatching(): void {
  if (dirWatcher) { dirWatcher.close(); dirWatcher = null; }
  if (cooldownTimer) { clearTimeout(cooldownTimer); cooldownTimer = null; }
}

/** Refresh cached panel list + output, triggering widget re-render. */
function refreshTabBar(): void {
  trailCachedPanels = discoverAllPanels();
  if (trailPanel) {
    // If trailed panel no longer exists, clear it
    if (!trailCachedPanels.some((p) => p.name === trailPanel)) {
      trailPanel = null;
      trailCachedOutput = [];
    } else {
      const maxLines = trailLines();
      trailCachedOutput = readPanelLogTail(trailPanel, maxLines);
    }
  }
  // Install/update widget if there are panels
  if (lastCtx?.hasUI) {
    if (trailCachedPanels.length > 0) {
      installTabBarWidget(lastCtx);
    } else {
      lastCtx.ui.setWidget("amux-trail", undefined);
    }
  }
}

// -- trailing widget ----------------------------------------------------------
//
// Non-blocking inline widget above the editor showing tab headers + last N
// lines of the selected panel. Toggled on/off via ⌥1-9 hotkeys.
// Auto-shown when amux_shell starts a new task.

let trailPanel: string | null = null;
let trailRefreshTimer: ReturnType<typeof setInterval> | null = null;

// Cached data from async refresh — render() reads this, never does I/O
let trailCachedPanels: PanelState[] = [];
let trailCachedOutput: string[] = [];

/** Read the tail of a panel's log file directly — no subprocess. */
function readPanelLogTail(name: string, maxLines: number): string[] {
  const logPath = join(PANEL_DIR, `${name}.log`);
  try {
    // Read last chunk of the log file (enough for maxLines)
    const CHUNK = 16384;
    const fd = openSync(logPath, "r");
    try {
      const st = fstatSync(fd);
      const size = st.size;
      if (size === 0) return [];
      const start = Math.max(0, size - CHUNK);
      const buf = Buffer.alloc(Math.min(CHUNK, size));
      readSync(fd, buf, 0, buf.length, start);
      // Strip ANSI escapes, split into lines, take tail
      const text = buf.toString("utf-8").replace(/\x1b\[[\d;?]*[A-Za-z]|\x1b\][^\x07]*\x07|\x1b\(B|\r/g, "");
      const lines = text.split("\n");
      // Drop empty trailing line from split
      if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
      return lines.slice(-maxLines);
    } finally {
      closeSync(fd);
    }
  } catch {
    return [];
  }
}

function showTrail(ctx: ExtensionContext, panelName: string): void {
  trailPanel = panelName;
  refreshTabBar();
  startTrailRefresh(ctx);
}

function hideTrail(ctx: ExtensionContext): void {
  trailPanel = null;
  trailCachedOutput = [];
  refreshTabBar();
}

function toggleTrail(ctx: ExtensionContext, panelName: string): void {
  if (trailPanel === panelName) {
    hideTrail(ctx);
  } else {
    showTrail(ctx, panelName);
  }
}

/** Install the tab bar widget — shows tabs always, output only when trailing. */
function installTabBarWidget(ctx: ExtensionContext): void {
  if (!ctx.hasUI) return;

  ctx.ui.setWidget("amux-trail", (_tui, theme) => {
    let cachedLines: string[] | undefined;
    let cachedWidth: number | undefined;
    let snapPanels = trailCachedPanels;
    let snapOutput = trailCachedOutput;
    let snapActive = trailPanel;

    function build(width: number): string[] {
      const activeName = trailPanel;
      const all = trailCachedPanels;
      const cwd = normalizePath(process.cwd());

      // Tab bar — "Amux" label, tabs separated by ·
      // States: trailed (blue bg) | fresh output (bright) | hot | stale (gray) | normal (dim)
      const now = Date.now();
      const tabs = all.map((p, i) => {
        const n = i + 1;
        const isStale = p.lastActivityMs > 0 && (now - p.lastActivityMs) > STALE_MS;
        const hasFreshOutput = (panelBlinkUntil[p.name] ?? 0) > now;

        if (p.name === activeName) {
          const label = n <= 9 ? ` ⌥${n} ${p.name} ` : ` ${p.name} `;
          return blueBgBlack(label);
        }

        const key = n <= 9 ? grayDim(`⌥${n} `) : "";

        if (hasFreshOutput) {
          // Check output volume in last 10s — burst gets extra bright
          const recentBytes = (panelOutputLog[p.name] || [])
            .filter(([t]) => now - t < BURST_WINDOW_MS)
            .reduce((sum, [, b]) => sum + b, 0);
          if (recentBytes > BURST_THRESHOLD) {
            // Burst: white bold — high activity
            return key + `\x1b[97;1m${p.name}${RESET}`;
          }
          // Fresh output: bright blue bold — subtle attention
          return key + `\x1b[94;1m${p.name}${RESET}`;
        }
        if (p.hot) {
          return key + blueFg(p.name);
        }
        if (isStale) {
          return key + grayDim(p.name);
        }
        return key + blueDim(p.name);
      });
      const sep = blueDim(" · ");
      const left = " " + tealDim("amux") + "  " + tabs.join(sep);
      const hint = activeName ? grayDim("⌥C interrupt · ⌥K kill") : "";
      const leftWidth = visibleWidth(left);
      const hintWidth = visibleWidth(hint);
      const gap = Math.max(1, width - leftWidth - hintWidth - 1);
      const tabLine = truncateToWidth(left + " ".repeat(gap) + hint + " ", width);

      // If not trailing, just show the tab bar
      if (!activeName) {
        return [tabLine];
      }

      // Thin blue divider
      const divider = blueDim("─".repeat(width));
      const numLines = trailLines();
      const outputLines = trailCachedOutput.slice(-numLines);

      const contentLines = outputLines.map((l) =>
        truncateToWidth(" " + theme.fg("toolOutput", l), width)
      );

      while (contentLines.length < numLines) {
        contentLines.push("");
      }

      return [
        tabLine,
        divider,
        ...contentLines,
      ];
    }

    return {
      render(width: number): string[] {
        // Check if data changed or any panel is blinking (need fresh render)
        const now = Date.now();
        const anyBlinking = Object.values(panelBlinkUntil).some((t) => t > now);
        if (snapPanels !== trailCachedPanels || snapOutput !== trailCachedOutput || snapActive !== trailPanel || anyBlinking) {
          cachedLines = undefined;
          snapPanels = trailCachedPanels;
          snapOutput = trailCachedOutput;
          snapActive = trailPanel;
        }
        if (cachedLines && cachedWidth === width) {
          return cachedLines;
        }
        cachedLines = build(width);
        cachedWidth = width;
        return cachedLines;
      },
      invalidate() {
        cachedLines = undefined;
        cachedWidth = undefined;
      },
    };
  });
}

function startTrailRefresh(ctx: ExtensionContext): void {
  stopTrailRefresh();
  trailRefreshTimer = setInterval(() => {
    if (ctx.hasUI) {
      refreshTabBar();
    } else {
      stopTrailRefresh();
    }
  }, TRAIL_REFRESH_MS);
}

function stopTrailRefresh(): void {
  if (trailRefreshTimer) {
    clearInterval(trailRefreshTimer);
    trailRefreshTimer = null;
  }
}

// -- rendering helpers --------------------------------------------------------

const PREVIEW_LINES = 5;

function renderOutput(output: string, expanded: boolean, theme: any): string {
  const trimmed = output.trim();
  if (!trimmed) return "";
  const lines = trimmed.split("\n");
  const maxLines = expanded ? lines.length : PREVIEW_LINES;
  const display = lines.slice(0, maxLines);
  const remaining = lines.length - maxLines;
  let text = display.map((l) => theme.fg("toolOutput", l)).join("\n");
  if (remaining > 0) {
    text += "\n" + theme.fg("muted", `… ${remaining} more lines, `) + keyHint("expandTools", "to expand");
  }
  return text;
}

function getTextContent(result: any): string {
  return (result.content || [])
    .filter((c: any) => c.type === "text")
    .map((c: any) => c.text || "")
    .join("\n");
}

// -- extension ----------------------------------------------------------------

let piRef: ExtensionAPI;

export default function (pi: ExtensionAPI) {
  piRef = pi;

  // --- lifecycle ---

  // --- system prompt injection ---

  const AMUX_SYSTEM_PROMPT = `
## Shell commands via amux

Use amux tools (amux_shell, amux_tail, amux_send_keys, amux_kill, amux_list) to run shell commands instead of bash. amux panels persist across calls and support long-running processes.

Primary workflow — run then tail:
1. amux_shell(name: "test", command: "npm test") — runs command, streams output (5s default timeout)
2. If it completes: output ends with SUCCESS or FAIL EXITCODE:N
3. If it times out: output includes a continuation hint with byte offset:
   ⏳ timeout 5s — continue with:
     amux_tail(name: "test", follow: true, offset: 4820)
4. Call amux_tail with that exact offset to resume — no output lost or duplicated
5. Chain amux_tail calls until the command completes

Panel names should be short and descriptive: server, build, test, worker, repl.
Use amux_send_keys with C-c to interrupt a running process.
`;

  pi.on("turn_start", (event) => {
    return {
      systemPrompt: event.systemPrompt + AMUX_SYSTEM_PROMPT,
    };
  });

  // --- lifecycle ---

  pi.on("session_start", (_event, ctx) => {
    lastCtx = ctx;
    startWatching(ctx);
    if (!amuxOnPath()) {
      ctx.ui.notify(
        "amux is not on your PATH. Run /amux install or: npm i -g https://github.com/tobi/amux",
        "warning",
      );
    }

    // Show tab bar (collapsed — no panel trailed) if panels exist
    refreshTabBar();
    startTrailRefresh(ctx);
  });
  pi.on("session_switch", (_event, ctx) => { lastCtx = ctx; startWatching(ctx); });
  pi.on("session_shutdown", () => { stopWatching(); stopTrailRefresh(); });
  pi.on("turn_end", (_event, ctx) => { lastCtx = ctx; });

  // --- ⌥1..9 toggle trailing ---

  for (let i = 1; i <= 9; i++) {
    pi.registerShortcut(Key.alt(String(i) as any), {
      description: `Toggle trailing for amux panel ${i}`,
      handler: async (ctx) => {
        const all = discoverAllPanels();
        if (i - 1 >= all.length) {
          if (all.length === 0) {
            ctx.ui.notify("No amux panels", "info");
          }
          return;
        }
        toggleTrail(ctx, all[i - 1].name);
      },
    });
  }

  // --- ⌥k kill currently trailed panel ---

  pi.registerShortcut(Key.alt("k"), {
    description: "Kill the currently trailed amux panel",
    handler: async (ctx) => {
      if (!trailPanel) {
        ctx.ui.notify("No panel being trailed", "info");
        return;
      }
      const name = trailPanel;
      amuxAsync([name, "kill"]).catch(() => {});
      hideTrail(ctx);
      ctx.ui.notify(`killed ${name}`, "info");
    },
  });

  // --- ⌥c send Ctrl-C to trailed panel ---

  pi.registerShortcut(Key.alt("c"), {
    description: "Send Ctrl-C to the currently trailed amux panel",
    handler: async (ctx) => {
      if (!trailPanel) {
        ctx.ui.notify("No panel being trailed", "info");
        return;
      }
      amuxAsync([trailPanel, "send-keys", "C-c", "-t0"]).catch(() => {});
    },
  });

  // --- ⌥d send Ctrl-D to trailed panel ---

  pi.registerShortcut(Key.alt("d"), {
    description: "Send Ctrl-D to the currently trailed amux panel",
    handler: async (ctx) => {
      if (!trailPanel) return;
      amuxAsync([trailPanel, "send-keys", "C-d", "-t0"]).catch(() => {});
    },
  });

  // --- tool: amux_shell ---

  pi.registerTool({
    name: "amux_shell",
    label: "amux shell",
    description: "Run a command in a named amux panel. Creates the panel if it doesn't exist. Streams output back.",
    promptSnippet: "Run a command in a named background panel (amux shell NAME CMD)",
    promptGuidelines: [
      "Use amux_shell for long-running processes (dev servers, build watchers, test suites) instead of bash when the process should keep running.",
      "Panel names should be short and descriptive: server, build, test, worker, repl.",
      "If amux_shell times out, the output includes a continuation hint with the byte offset. Use amux_tail with that offset to resume exactly where it left off.",
      "Use amux_send_keys with C-c to stop a running process.",
    ],
    parameters: Type.Object({
      name: Type.String({ description: "Panel name (e.g. server, build, test)" }),
      command: Type.String({ description: "Shell command to run" }),
      timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (default: 5)" })),
    }),

    renderCall(args, theme) {
      const name = args.name || "…";
      const cmd = args.command || "…";
      return new Text(
        theme.fg("dim", "amux ") + theme.fg("accent", theme.bold(name)) + theme.fg("dim", " · $ ") + theme.fg("toolOutput", cmd),
        0, 0,
      );
    },

    renderResult(result, { expanded, isPartial }, theme) {
      if (isPartial) return new Text(theme.fg("muted", "⠿ running…"), 0, 0);
      const output = getTextContent(result);
      if (result.isError) return new Text(theme.fg("error", output || "error"), 0, 0);
      const rendered = renderOutput(output, expanded, theme);
      return rendered ? new Text(rendered, 0, 0) : undefined;
    },

    async execute(_toolCallId, params, signal) {
      const { name, command } = params;

      // Fire command into panel (returns immediately)
      await amuxFireAndForget(name, command);

      // Auto-trail this panel
      if (lastCtx?.hasUI) {
        showTrail(lastCtx, name);
      }

      // Wait for command to complete (sentinel in log) or timeout
      const result = await waitForDone(name, signal, 120_000);

      // Read panel output for LLM
      const snap = await amuxAsync([name, "tail", "--lines=100"]);
      const exitCode = result?.exitCode ?? null;
      const done = exitCode !== null;

      let text = snap.stdout?.trim() || "";
      if (!done) {
        text += `\n\n(command still running in panel "${name}" — use amux_tail to check later)`;
      }

      return {
        content: [{ type: "text", text: text || `started in panel ${name}` }],
        details: { panel: name, command, exitCode, done },
      };
    },
  });

  // --- tool: amux_tail ---

  pi.registerTool({
    name: "amux_tail",
    label: "amux tail",
    description: "Tail output from a named panel. Returns last N lines, optionally following live output until the command finishes or timeout. Use offset to continue from where a previous run/tail stopped.",
    promptSnippet: "Tail output from a named background panel (amux tail NAME)",
    promptGuidelines: [
      "Use amux_tail to check on background processes.",
      "Default: last 10 lines, no follow, 60s timeout.",
      "Use follow:true to wait for command completion (like tail -f).",
      "Use offset to continue from where a previous amux_shell or amux_tail timed out — the timeout message tells you the exact offset.",
    ],
    parameters: Type.Object({
      name: Type.String({ description: "Panel name" }),
      follow: Type.Optional(Type.Boolean({ description: "Follow live output until done or timeout (default: false)" })),
      lines: Type.Optional(Type.Number({ description: "Number of tail lines (default: 10)" })),
      timeout: Type.Optional(Type.Number({ description: "Timeout in seconds when following (default: 60)" })),
      offset: Type.Optional(Type.Number({ description: "Byte offset to start from (continue after run/tail timeout)" })),
    }),

    renderCall(args, theme) {
      const name = args.name || "…";
      const follow = args.follow ? theme.fg("dim", " -f") : "";
      const lines = args.lines ? theme.fg("dim", ` --lines=${args.lines}`) : "";
      const offset = args.offset != null ? theme.fg("dim", ` -c ${args.offset}`) : "";
      return new Text(
        theme.fg("dim", "amux ") + theme.fg("accent", theme.bold(name)) + theme.fg("dim", " · tail") + follow + lines + offset,
        0, 0,
      );
    },

    renderResult(result, { expanded, isPartial }, theme) {
      if (isPartial) return new Text(theme.fg("muted", "⠿ tailing…"), 0, 0);
      const output = getTextContent(result);
      if (result.isError) return new Text(theme.fg("error", output || "error"), 0, 0);
      const rendered = renderOutput(output, expanded, theme);
      return rendered ? new Text(rendered, 0, 0) : undefined;
    },

    async execute(_toolCallId, params) {
      const args = [params.name, "tail"];
      if (params.follow) args.push("--follow");
      if (params.lines) args.push(`--lines=${params.lines}`);
      if (params.offset != null) args.push("-c", String(params.offset));
      const t = params.timeout ?? 60;
      args.push(`-t${t}`);
      const result = await amuxAsync(args, t + 5);
      return {
        content: [{ type: "text", text: result.stdout || "(empty)" }],
        details: { panel: params.name, follow: !!params.follow, lines: params.lines ?? 10, offset: params.offset },
      };
    },
  });

  // --- tool: amux_send_keys ---

  pi.registerTool({
    name: "amux_send_keys",
    label: "amux send-keys",
    description: "Send keystrokes to a named panel. Use for Ctrl-C, typing into REPLs, etc.",
    promptSnippet: "Send keystrokes to a named background panel (amux send-keys NAME KEYS...)",
    parameters: Type.Object({
      name: Type.String({ description: "Panel name" }),
      keys: Type.Array(Type.String(), {
        description: 'Keys to send. Special keys: C-c, C-d, C-z, Enter, Tab, Esc, Space, Up, Down, Left, Right, BSpace. Literal text is sent as-is.',
      }),
      timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (default: 5)" })),
    }),

    renderCall(args, theme) {
      const name = args.name || "…";
      const keys = (args.keys || []).map((k: string) => {
        if (/^C-.|^Enter$|^Tab$|^Esc$|^Space$|^BSpace$|^Up$|^Down$|^Left$|^Right$/.test(k)) {
          return theme.fg("warning", k);
        }
        return theme.fg("toolOutput", k);
      }).join(theme.fg("dim", " "));
      return new Text(
        theme.fg("dim", "amux ") + theme.fg("accent", theme.bold(name)) + theme.fg("dim", " · ⌨ ") + keys,
        0, 0,
      );
    },

    renderResult(result, { expanded, isPartial }, theme) {
      if (isPartial) return new Text(theme.fg("muted", "⠿ sending…"), 0, 0);
      const output = getTextContent(result);
      if (result.isError) return new Text(theme.fg("error", output || "error"), 0, 0);
      const rendered = renderOutput(output, expanded, theme);
      return rendered ? new Text(rendered, 0, 0) : undefined;
    },

    async execute(_toolCallId, params, signal) {
      const { name, keys } = params;
      // Send keys (returns immediately)
      await amuxAsync([name, "send-keys", ...keys, "-t0"], 5);

      // If the keys include Enter, a command may be running — wait for completion
      const hasEnter = keys.some((k) => k === "Enter" || k === "enter");
      if (hasEnter) {
        await waitForDone(name, signal, 30_000);
      } else {
        // Brief pause for non-command keys (C-c, text, etc.)
        await new Promise((r) => setTimeout(r, 500));
      }

      const snap = await amuxAsync([name, "tail"]);
      return {
        content: [{ type: "text", text: snap.stdout || "(no output)" }],
        details: { panel: name, keys },
      };
    },
  });

  // --- tool: amux_kill ---

  pi.registerTool({
    name: "amux_kill",
    label: "amux kill",
    description: "Remove a single panel.",
    promptSnippet: "Remove a named background panel (amux kill NAME)",
    parameters: Type.Object({
      name: Type.String({ description: "Panel name to remove" }),
    }),

    renderCall(args, theme) {
      return new Text(
        theme.fg("dim", "amux ") + theme.fg("accent", theme.bold(args.name || "…")) + theme.fg("dim", " · kill"),
        0, 0,
      );
    },

    renderResult(result, { isPartial }, theme) {
      if (isPartial) return undefined;
      const name = result.details?.panel || "panel";
      if (result.isError) return new Text(theme.fg("error", getTextContent(result) || "error"), 0, 0);
      return new Text(theme.fg("success", "✓") + theme.fg("dim", ` ${name} removed`), 0, 0);
    },

    async execute(_toolCallId, params) {
      const result = await amuxAsync([params.name, "kill"]);
      if (trailPanel === params.name && lastCtx) {
        hideTrail(lastCtx);
      }
      // Clean up blink/size tracking
      delete panelBlinkUntil[params.name];
      delete panelLogSizes[params.name];
      return {
        content: [{ type: "text", text: result.stdout || `killed ${params.name}` }],
        details: { panel: params.name },
      };
    },
  });

  // --- tool: amux_list ---

  pi.registerTool({
    name: "amux_list",
    label: "amux list",
    description: "List all active panels.",
    promptSnippet: "List all active background panels (amux list)",
    parameters: Type.Object({}),

    renderCall(_args, theme) {
      return new Text(
        theme.fg("dim", "amux ") + theme.fg("dim", "· list"),
        0, 0,
      );
    },

    renderResult(result, { isPartial }, theme) {
      if (isPartial) return undefined;
      const output = getTextContent(result).trim();
      if (result.isError) return new Text(theme.fg("error", output || "error"), 0, 0);
      if (!output || output === "no panels") return new Text(theme.fg("dim", "no panels"), 0, 0);
      const lines = output.split("\n").map((line) => {
        const parts = line.trim().split(/\t+/);
        if (parts.length >= 2) return theme.fg("muted", parts[0] + " ") + theme.fg("accent", parts[1]);
        return theme.fg("toolOutput", line);
      });
      return new Text(lines.join("\n"), 0, 0);
    },

    async execute() {
      const result = await amuxAsync(["list"]);
      return {
        content: [{ type: "text", text: result.stdout || "no panels" }],
        details: {},
      };
    },
  });

  // --- command: /amux ---

  pi.registerCommand("amux", {
    description: "Manage amux — /amux <panel> (trail panel), /amux install (add to PATH), /amux (toggle trail)",
    handler: async (args, ctx) => {
      const sub = args.trim();

      // /amux install — symlink into a PATH directory
      if (sub === "install") {
        const bin = amuxBin();
        const candidates = [
          join(homedir(), ".local", "bin"),
          join(homedir(), ".local", "share", "bin"),
        ];
        const pathDirs = (process.env.PATH || "").split(":");
        const target = candidates.find((d) => pathDirs.includes(d));

        if (!target) {
          ctx.ui.notify(
            `Neither ~/.local/bin nor ~/.local/share/bin is on your PATH.\nAdd one to your shell profile first, then retry.`,
            "error",
          );
          return;
        }

        const link = join(target, "amux");

        try {
          if (existsSync(link) || lstatSync(link).isSymbolicLink?.()) {
            const existing = readlinkSync(link);
            if (realpathSync(existing) === realpathSync(bin)) {
              ctx.ui.notify(`amux already installed → ${link}`, "info");
              return;
            }
            unlinkSync(link);
          }
        } catch {}

        try {
          mkdirSync(target, { recursive: true });
          symlinkSync(bin, link);
          ctx.ui.notify(`✓ amux symlinked → ${link}`, "success");
        } catch (e: any) {
          ctx.ui.notify(`Failed to symlink: ${e.message}`, "error");
        }
        return;
      }

      // /amux <name> — trail that panel (or create + trail if it looks like a panel name)
      if (sub) {
        const all = discoverAllPanels();
        const match = all.find((p) => p.name === sub);
        if (match) {
          showTrail(ctx, match.name);
          return;
        }
        // Not an existing panel — treat as shell command in "shell" panel
        await amuxFireAndForget("shell", sub);
        showTrail(ctx, "shell");
        return;
      }

      // /amux — toggle trail for first panel
      const all = discoverAllPanels();
      if (all.length === 0) {
        ctx.ui.notify("No amux panels", "info");
        return;
      }
      if (trailPanel) {
        hideTrail(ctx);
      } else {
        const hot = all.find((p) => p.hot);
        showTrail(ctx, hot ? hot.name : all[0].name);
      }
    },
  });
}
