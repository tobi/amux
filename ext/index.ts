/**
 * amux — pi extension
 *
 * Tools for running background tasks in named tmux panels.
 * Calls the amux library directly (fully async, no subprocess).
 * Status bar shows active panels with pulsing on live output.
 * ⌥1..9 toggles inline trailing widget for panel output.
 * ⌥k kills the currently trailed panel.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { keyHint, truncateTail } from "@mariozechner/pi-coding-agent";
import { Text, Key, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { readdirSync, readFileSync, statSync, watch as fsWatch, mkdirSync,
  symlinkSync, unlinkSync, existsSync, lstatSync, readlinkSync, realpathSync,
  openSync, readSync, closeSync, fstatSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import type { FSWatcher } from "node:fs";

// Import amux library directly — fully async, no subprocess needed
import {
  run as amuxRun, tail as amuxTail, sendKeys as amuxSendKeys,
  kill as amuxKill, list as amuxList, panels as amuxPanels,
  panelLogPath, panelCwd, ensurePanel, rejectNesting, config,
  cwdToTabName,
  type RunResult,
} from "../src/amux.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PANEL_DIR = config.panelDir;
const HOT_MS = 5000;
const TRAIL_MIN_LINES = 5;
const TRAIL_SCREEN_FRACTION = 0.33;
const TRAIL_REFRESH_MS = 1000;
const LIVE_WIDGET_PREFIX = 'amux-live/';
const LIVE_WIDGET_DELAY_MS = 100;
const LIVE_WIDGET_HEIGHT = 15;
const LIVE_WIDGET_REFRESH_MS = 200;

// ANSI helpers
const BLUE_FG = "\x1b[34m";
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";

function blueFg(s: string): string { return `${BLUE_FG}${s}${RESET}`; }
function blueBgBlack(s: string): string { return `\x1b[30;1;44m${s}${RESET}`; }
function blueDim(s: string): string { return `${BLUE_FG}${DIM}${s}${RESET}`; }
function grayDim(s: string): string { return `\x1b[38;5;239m${s}${RESET}`; }
function tealDim(s: string): string { return `\x1b[38;2;94;182;176m${DIM}${s}${RESET}`; }
function accentFg(s: string): string { return `\x1b[38;2;77;163;255m${s}${RESET}`; }

function trailLines(): number {
  const rows = process.stdout.rows || 24;
  return Math.max(TRAIL_MIN_LINES, Math.floor(rows * TRAIL_SCREEN_FRACTION));
}

// -- live widget helpers ------------------------------------------------------

function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds.toFixed(1)}s`;
  const wholeSeconds = Math.floor(totalSeconds);
  const hours = Math.floor(wholeSeconds / 3600);
  const minutes = Math.floor((wholeSeconds % 3600) / 60);
  const seconds = wholeSeconds % 60;
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function buildLiveWidgetLines(
  panelName: string, logLines: string[], width: number, rows: number, elapsedMs: number,
): string[] {
  const accent = `\x1b[38;2;77;163;255m`;
  const reset = '\x1b[0m';
  const innerWidth = Math.max(10, width - 2);
  const timer = ` ${formatElapsed(elapsedMs)} `;
  const title = ` ${panelName} `;
  const fill = '─'.repeat(Math.max(0, innerWidth - title.length - timer.length));
  const topInner = `${title}${fill}${timer}`.padEnd(innerWidth, '─').slice(0, innerWidth);
  const top = `${accent}╭${topInner}╮${reset}`;
  const bottom = `${accent}╰${'─'.repeat(innerWidth)}╯${reset}`;
  const display = logLines.slice(-rows);
  const body: string[] = [];
  for (let i = 0; i < rows; i++) {
    const raw = display[i] ?? '';
    // Truncate visible width and pad
    const line = truncateToWidth(raw, innerWidth).padEnd(innerWidth);
    // Re-truncate after padding (padEnd adds spaces but visible width might differ)
    const fitted = truncateToWidth(line, innerWidth);
    body.push(`${accent}│${reset}${fitted}${accent}│${reset}`);
  }
  return [top, ...body, bottom];
}

interface LiveWidget {
  panelName: string;
  startedAt: number;
  timer?: ReturnType<typeof setTimeout>;
  refreshTimer?: ReturnType<typeof setInterval>;
  disposed: boolean;
  requestRender?: () => void;
}

function showLiveWidget(ctx: ExtensionContext, toolCallId: string, widget: LiveWidget): void {
  if (!ctx.hasUI || widget.disposed) return;
  ctx.ui.setWidget(`${LIVE_WIDGET_PREFIX}${toolCallId}`, (_tui, theme) => {
    let cachedLines: string[] | undefined;
    let cachedWidth: number | undefined;
    widget.requestRender = () => { cachedLines = undefined; _tui.requestRender(); };
    return {
      invalidate() { cachedLines = undefined; cachedWidth = undefined; },
      render(width: number): string[] {
        if (cachedLines && cachedWidth === width) return cachedLines;
        const logLines = readPanelLogAll(widget.panelName).slice(-LIVE_WIDGET_HEIGHT);
        cachedLines = buildLiveWidgetLines(
          widget.panelName, logLines, width, LIVE_WIDGET_HEIGHT,
          Date.now() - widget.startedAt,
        );
        cachedWidth = width;
        return cachedLines;
      },
    };
  });
  // Refresh the widget periodically for timer updates and new output
  widget.refreshTimer = setInterval(() => {
    if (widget.disposed) return;
    widget.requestRender?.();
  }, LIVE_WIDGET_REFRESH_MS);
}

function hideLiveWidget(ctx: ExtensionContext | null, toolCallId: string, widget: LiveWidget): void {
  widget.disposed = true;
  if (widget.timer) clearTimeout(widget.timer);
  if (widget.refreshTimer) clearInterval(widget.refreshTimer);
  if (ctx?.hasUI) ctx.ui.setWidget(`${LIVE_WIDGET_PREFIX}${toolCallId}`, undefined);
}

// -- panel discovery ----------------------------------------------------------

interface PanelState {
  name: string;
  hot: boolean;
  lastActivityMs: number;
  cwd: string | undefined;
  tab: string | undefined;  // session tab name from .tab sidecar
}

const STALE_MS = 3 * 60 * 1000;
const BLINK_MS = 2000;
const panelLogSizes: Record<string, number> = {};
const panelBlinkUntil: Record<string, number> = {};
const panelOutputLog: Record<string, [number, number][]> = {};
const BURST_WINDOW_MS = 10_000;
const BURST_THRESHOLD = 500;

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
        const prevSize = panelLogSizes[name] ?? st.size;
        const delta = st.size - prevSize;
        if (delta > 0) {
          if (!panelOutputLog[name]) panelOutputLog[name] = [];
          panelOutputLog[name].push([now, delta]);
          panelOutputLog[name] = panelOutputLog[name].filter(([t]) => now - t < BURST_WINDOW_MS);
          if (name !== trailPanel) panelBlinkUntil[name] = now + BLINK_MS;
        }
        panelLogSizes[name] = st.size;
      } catch {}
      let cwd: string | undefined;
      try { cwd = readFileSync(join(PANEL_DIR, `${name}.cwd`), "utf-8").trim() || undefined; } catch {}
      let tab: string | undefined;
      try { tab = readFileSync(join(PANEL_DIR, `${name}.tab`), "utf-8").trim() || undefined; } catch {}
      panels.push({ name, hot, lastActivityMs, cwd, tab });
    }
    return panels.sort((a, b) => a.name.localeCompare(b.name));
  } catch { return []; }
}

function normalizePath(p: string): string {
  try { return realpathSync(p); } catch { return p; }
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

function refreshTabBar(): void {
  const allPanels = discoverAllPanels();
  // Filter to only panels in this pi session's session (tab)
  trailCachedPanels = currentSessionTab
    ? allPanels.filter(p => p.tab === currentSessionTab)
    : allPanels;
  if (trailPanel) {
    if (!trailCachedPanels.some((p) => p.name === trailPanel)) {
      trailPanel = null;
      trailCachedOutput = [];
    } else {
      trailCachedOutput = readPanelLogTail(trailPanel, trailLines());
    }
  }
  if (lastCtx?.hasUI) {
    if (trailCachedPanels.length > 0) installTabBarWidget(lastCtx);
    else lastCtx.ui.setWidget("amux-trail", undefined);
  }
}

// -- trailing widget ----------------------------------------------------------

let trailPanel: string | null = null;
let trailRefreshTimer: ReturnType<typeof setInterval> | null = null;
let trailCachedPanels: PanelState[] = [];  // filtered to current session only
let trailCachedOutput: string[] = [];
let currentSessionTab: string | null = null;  // tab name for this pi session's cwd
let trailScrollOffset = 0;  // 0 = auto-follow (show latest), >0 = lines scrolled up
let trailTotalLines = 0;    // total lines available in log
let trailPinned = false;    // true when user has scrolled up

/** Read all available lines from panel log (up to a reasonable buffer).
 *  Strips alt-screen regions (vim, less, top etc), cursor movement,
 *  erase sequences, and other full-screen TUI noise. Keeps colors. */
function readPanelLogAll(name: string): string[] {
  const logPath = join(PANEL_DIR, `${name}.log`);
  try {
    const CHUNK = 131072;  // 128KB — plenty for scrollback
    const fd = openSync(logPath, "r");
    try {
      const st = fstatSync(fd);
      if (st.size === 0) return [];
      const start = Math.max(0, st.size - CHUNK);
      const buf = Buffer.alloc(Math.min(CHUNK, st.size));
      readSync(fd, buf, 0, buf.length, start);
      let text = buf.toString("utf-8");

      // Strip alt-screen regions: everything between \e[?1049h and \e[?1049l
      // Also handle ?47h/?47l and ?1047h/?1047l (older alt-screen variants)
      text = text.replace(/\x1b\[\?(?:1049|1047|47)h[\s\S]*?\x1b\[\?(?:1049|1047|47)l/g, "");
      // If we're still inside an alt-screen (no closing sequence), drop from the opener onward
      text = text.replace(/\x1b\[\?(?:1049|1047|47)h[\s\S]*$/, "");

      text = text
        .replace(/\x1b\[\?[\d;]*[A-Za-z]/g, "")       // strip remaining private modes (?2004h etc)
        .replace(/\x1b\][\s\S]*?(?:\x1b\\|\x07)/g, "")  // strip OSC (window title)
        .replace(/\x1b[()#][A-Za-z0-9]/g, "")          // strip charset switching
        .replace(/\x1b\[\d*[ABCDEFGHIJKST]/g, "")      // strip cursor movement & erase (up/down/fwd/back/erase)
        .replace(/\x1b\[\d*;\d*[Hf]/g, "")             // strip cursor positioning (CSI row;col H/f)
        .replace(/\x1b\[\d*[Hf]/g, "")                 // strip cursor positioning (CSI col H/f)
        .replace(/\x1b\[[=>][\d;]*[A-Za-z]/g, "")      // strip CSI > and CSI = sequences
        .replace(/\x1b\[\d*X/g, "")                    // strip erase character
        .replace(/\x1b\[\d*[LP]/g, "")                 // strip insert/delete line
        .replace(/\r/g, "");                            // strip \r

      // Collapse runs of blank lines (common after stripping)
      const lines = text.split("\n");
      const result: string[] = [];
      let lastBlank = false;
      for (const line of lines) {
        const blank = line.trim() === "";
        if (blank && lastBlank) continue;
        result.push(line);
        lastBlank = blank;
      }
      if (result.length > 0 && result[result.length - 1].trim() === "") result.pop();
      return result;
    } finally { closeSync(fd); }
  } catch { return []; }
}

function readPanelLogTail(name: string, maxLines: number): string[] {
  const all = readPanelLogAll(name);
  trailTotalLines = all.length;
  if (trailPinned) {
    // Show a window scrolled up by trailScrollOffset from the end
    const end = Math.max(0, all.length - trailScrollOffset);
    const start = Math.max(0, end - maxLines);
    return all.slice(start, end);
  }
  // Auto-follow: show last maxLines
  trailScrollOffset = 0;
  return all.slice(-maxLines);
}

function showTrail(ctx: ExtensionContext, panelName: string): void {
  trailPanel = panelName;
  trailScrollOffset = 0;
  trailPinned = false;
  refreshTabBar();
  startTrailRefresh(ctx);
}

function hideTrail(ctx: ExtensionContext): void {
  trailPanel = null;
  trailCachedOutput = [];
  trailScrollOffset = 0;
  trailPinned = false;
  refreshTabBar();
}

function toggleTrail(ctx: ExtensionContext, panelName: string): void {
  if (trailPanel === panelName) hideTrail(ctx);
  else showTrail(ctx, panelName);
}

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
      const now = Date.now();
      const tabs = all.map((p, i) => {
        const n = i + 1;
        const isStale = p.lastActivityMs > 0 && (now - p.lastActivityMs) > STALE_MS;
        const hasFresh = (panelBlinkUntil[p.name] ?? 0) > now;
        if (p.name === activeName) {
          const label = n <= 9 ? ` \u2325${n} ${p.name} ` : ` ${p.name} `;
          return blueBgBlack(label);
        }
        const key = n <= 9 ? grayDim(`\u2325${n} `) : "";
        if (hasFresh) {
          const recent = (panelOutputLog[p.name] || []).filter(([t]) => now - t < BURST_WINDOW_MS).reduce((s, [, b]) => s + b, 0);
          if (recent > BURST_THRESHOLD) return key + `\x1b[97;1m${p.name}${RESET}`;
          return key + `\x1b[94;1m${p.name}${RESET}`;
        }
        if (p.hot) return key + blueFg(p.name);
        if (isStale) return key + grayDim(p.name);
        return key + blueDim(p.name);
      });
      const sep = blueDim(" \u00b7 ");
      const left = tealDim("amux") + " " + tabs.join(sep);
      const scrollHint = (activeName && trailPinned)
        ? grayDim(`\u2191${trailScrollOffset} `) : "";
      const hint = activeName
        ? scrollHint + grayDim("\u2325PgUp/Dn scroll \u00b7 \u2325C interrupt \u00b7 \u2325K kill")
        : "";
      const gap = Math.max(1, width - visibleWidth(left) - visibleWidth(hint) - 1);
      const tabLine = truncateToWidth(left + " ".repeat(gap) + hint + " ", width);
      if (!activeName) return [tabLine];
      const divider = blueDim("\u2500".repeat(width));
      const numLines = trailLines();
      const outputLines = trailCachedOutput.slice(-numLines);
      const contentLines = outputLines.map((l) => truncateToWidth(" " + theme.fg("toolOutput", l), width));
      while (contentLines.length < numLines) contentLines.push("");
      return [tabLine, divider, ...contentLines];
    }

    return {
      render(width: number): string[] {
        const now = Date.now();
        const anyBlinking = Object.values(panelBlinkUntil).some((t) => t > now);
        if (snapPanels !== trailCachedPanels || snapOutput !== trailCachedOutput || snapActive !== trailPanel || anyBlinking) {
          cachedLines = undefined;
          snapPanels = trailCachedPanels; snapOutput = trailCachedOutput; snapActive = trailPanel;
        }
        if (cachedLines && cachedWidth === width) return cachedLines;
        cachedLines = build(width); cachedWidth = width;
        return cachedLines;
      },
      invalidate() { cachedLines = undefined; cachedWidth = undefined; },
    };
  });
}

function startTrailRefresh(ctx: ExtensionContext): void {
  stopTrailRefresh();
  trailRefreshTimer = setInterval(() => {
    if (ctx.hasUI) refreshTabBar();
    else stopTrailRefresh();
  }, TRAIL_REFRESH_MS);
}

function stopTrailRefresh(): void {
  if (trailRefreshTimer) { clearInterval(trailRefreshTimer); trailRefreshTimer = null; }
}

// -- rendering helpers --------------------------------------------------------

const PREVIEW_LINES = 8;

function renderOutput(output: string, expanded: boolean, theme: any): string {
  const trimmed = output.trim();
  if (!trimmed) return "";
  const lines = trimmed.split("\n");
  if (expanded) {
    return lines.map((l) => theme.fg("toolOutput", l)).join("\n");
  }
  // Collapsed: show last N lines (tail-style, more useful than head)
  const skipped = Math.max(0, lines.length - PREVIEW_LINES);
  const display = lines.slice(-PREVIEW_LINES);
  let text = "";
  if (skipped > 0) text += theme.fg("muted", `\u2026 ${skipped} earlier lines, `) + keyHint("expandTools", "to expand") + "\n";
  text += display.map((l) => theme.fg("toolOutput", l)).join("\n");
  return text;
}

function getTextContent(result: any): string {
  // Prefer full output from details (untruncated) for rendering
  if (result.details?.fullOutput) return result.details.fullOutput;
  return (result.content || []).filter((c: any) => c.type === "text").map((c: any) => c.text || "").join("\n");
}

// -- extension ----------------------------------------------------------------

export default function (pi: ExtensionAPI) {

  // --- lifecycle ---

  function updateSessionTab(ctx: ExtensionContext): void {
    currentSessionTab = cwdToTabName(ctx.cwd || process.cwd());
  }

  pi.on("session_start", (_event, ctx) => {
    lastCtx = ctx;
    updateSessionTab(ctx);
    startWatching(ctx);
    refreshTabBar();
    startTrailRefresh(ctx);
  });
  pi.on("session_switch", (_event, ctx) => { lastCtx = ctx; updateSessionTab(ctx); startWatching(ctx); });
  pi.on("session_shutdown", () => { stopWatching(); stopTrailRefresh(); });
  pi.on("turn_end", (_event, ctx) => { lastCtx = ctx; updateSessionTab(ctx); });

  // --- ⌥1..9 toggle trailing ---

  for (let i = 1; i <= 9; i++) {
    pi.registerShortcut(Key.alt(String(i) as any), {
      description: `Toggle trailing for amux panel ${i}`,
      handler: async (ctx) => {
        updateSessionTab(ctx);
        refreshTabBar();
        const all = trailCachedPanels;
        if (i - 1 >= all.length) { if (all.length === 0) ctx.ui.notify("No amux panels in this session", "info"); return; }
        toggleTrail(ctx, all[i - 1].name);
      },
    });
  }

  pi.registerShortcut(Key.alt("k"), {
    description: "Kill the currently trailed amux panel",
    handler: async (ctx) => {
      if (!trailPanel) { ctx.ui.notify("No panel being trailed", "info"); return; }
      const name = trailPanel;
      amuxKill(name).catch(() => {});
      hideTrail(ctx);
      ctx.ui.notify(`killed ${name}`, "info");
    },
  });

  pi.registerShortcut(Key.alt("c"), {
    description: "Send Ctrl-C to the currently trailed amux panel",
    handler: async () => {
      if (!trailPanel) return;
      amuxSendKeys(trailPanel, ["C-c"], { timeout: 0 }).catch(() => {});
    },
  });

  pi.registerShortcut(Key.alt("d"), {
    description: "Send Ctrl-D to the currently trailed amux panel",
    handler: async () => {
      if (!trailPanel) return;
      amuxSendKeys(trailPanel, ["C-d"], { timeout: 0 }).catch(() => {});
    },
  });

  // --- ⌥PgUp/⌥PgDn scroll trailing widget ---

  const SCROLL_STEP = 5;

  pi.registerShortcut(Key.alt("pageup" as any), {
    description: "Scroll amux trail up",
    handler: async (ctx) => {
      if (!trailPanel) return;
      trailPinned = true;
      trailScrollOffset = Math.min(trailScrollOffset + SCROLL_STEP, Math.max(0, trailTotalLines - trailLines()));
      refreshTabBar();
    },
  });

  pi.registerShortcut(Key.alt("pagedown" as any), {
    description: "Scroll amux trail down",
    handler: async (ctx) => {
      if (!trailPanel) return;
      trailScrollOffset = Math.max(0, trailScrollOffset - SCROLL_STEP);
      if (trailScrollOffset === 0) trailPinned = false;
      refreshTabBar();
    },
  });

  // --- tool: amux_run ---

  pi.registerTool({
    name: "amux_shell",
    label: "amux run",
    description: "Run a command in a named amux panel. Creates the panel if it doesn't exist. Streams output back.",
    promptSnippet: "Run a command in a named background panel (amux run NAME CMD)",
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
      force: Type.Optional(Type.Boolean({ description: "Kill any running command first (default: false)" })),
    }),

    renderCall(args, theme) {
      const name = args.name || "\u2026";
      const cmd = args.command || "\u2026";
      return new Text(
        theme.fg("dim", "amux ") + theme.fg("accent", theme.bold(name)) + theme.fg("dim", " \u00b7 $ ") + theme.fg("toolOutput", cmd),
        0, 0,
      );
    },

    renderResult(result, { expanded, isPartial }, theme) {
      const output = getTextContent(result);
      if (result.isError) return new Text(theme.fg("error", output || "error"), 0, 0);
      if (isPartial) {
        if (!output?.trim()) return new Text(theme.fg("muted", "\u2807 running\u2026"), 0, 0);
        return new Text(renderOutput(output, expanded, theme), 0, 0);
      }
      const rendered = renderOutput(output, expanded, theme);
      return rendered ? new Text(rendered, 0, 0) : undefined;
    },

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const { name, command } = params;
      const timeout = params.timeout ?? 5;
      rejectNesting(command);
      const cwd = ctx?.cwd || process.cwd();
      const fullCommand = `cd ${cwd} && ${command}`;

      // Show live terminal widget while running
      const liveWidget: LiveWidget = { panelName: name, startedAt: Date.now(), disposed: false };
      if (ctx?.hasUI) {
        liveWidget.timer = setTimeout(() => showLiveWidget(ctx, _toolCallId, liveWidget), LIVE_WIDGET_DELAY_MS);
      }

      // Auto-trail this panel
      if (ctx && lastCtx) showTrail(lastCtx, name);

      // Stream output lines incrementally via onUpdate
      const lines: string[] = [];
      let result: RunResult;
      try {
        result = await amuxRun(name, fullCommand, {
          skipNestingCheck: true,
          force: params.force,
          timeout,
          signal,
          onLine: (line) => {
            lines.push(line);
            onUpdate?.({ content: [{ type: "text", text: lines.join("\n") }] });
          },
        });
      } finally {
        hideLiveWidget(ctx, _toolCallId, liveWidget);
      }

      let text = lines.join("\n");

      let suffix = "";
      if (result.aborted) {
        suffix = `\n\n⊘ aborted \u2014 continue with:\n  amux_tail(name: "${name}", follow: true, offset: ${result.endPos})`;
      } else if (result.timedOut) {
        suffix = `\n\n\u23f3 timeout ${timeout}s \u2014 continue with:\n  amux_tail(name: "${name}", follow: true, offset: ${result.endPos})`;
      } else if (result.exitCode !== undefined) {
        suffix = result.exitCode === 0 ? "\n\nSUCCESS" : `\n\nFAIL EXITCODE:${result.exitCode}`;
      }

      // Truncate for LLM (last 2000 lines / 50KB), keep full for renderResult
      const fullText = text + suffix;
      const truncated = truncateTail(text);
      const llmText = truncated.content + suffix;

      return {
        content: [{ type: "text", text: llmText || `started in panel ${name}` }],
        details: { panel: name, command, exitCode: result.exitCode, timedOut: result.timedOut, endPos: result.endPos, fullOutput: fullText },
      };
    },
  });

  // --- tool: amux_tail ---

  pi.registerTool({
    name: "amux_tail",
    label: "amux tail",
    description: "Tail output from a named panel. Returns last N lines, optionally following live output. Use offset to continue from where a previous run/tail stopped.",
    promptSnippet: "Tail output from a named background panel (amux tail NAME)",
    promptGuidelines: [
      "Use amux_tail to check on background processes.",
      "Default: last 10 lines, no follow, 60s timeout.",
      "Use follow:true to wait for command completion (like tail -f).",
      "Use offset to continue from where a previous amux_shell or amux_tail timed out \u2014 the timeout message tells you the exact offset.",
    ],
    parameters: Type.Object({
      name: Type.String({ description: "Panel name" }),
      follow: Type.Optional(Type.Boolean({ description: "Follow live output until done or timeout (default: false)" })),
      lines: Type.Optional(Type.Number({ description: "Number of tail lines (default: 10)" })),
      timeout: Type.Optional(Type.Number({ description: "Timeout in seconds when following (default: 60)" })),
      offset: Type.Optional(Type.Number({ description: "Byte offset to start from (continue after run/tail timeout)" })),
      grep: Type.Optional(Type.String({ description: "Regex filter — only matching lines are returned" })),
    }),

    renderCall(args, theme) {
      const name = args.name || "\u2026";
      const follow = args.follow ? theme.fg("dim", " -f") : "";
      const lines = args.lines ? theme.fg("dim", ` --lines=${args.lines}`) : "";
      const offset = args.offset != null ? theme.fg("dim", ` -c ${args.offset}`) : "";
      const grep = args.grep ? theme.fg("dim", ` --grep `) + theme.fg("warning", args.grep) : "";
      return new Text(
        theme.fg("dim", "amux ") + theme.fg("accent", theme.bold(name)) + theme.fg("dim", " \u00b7 tail") + follow + lines + offset + grep,
        0, 0,
      );
    },

    renderResult(result, { expanded, isPartial }, theme) {
      const output = getTextContent(result);
      if (result.isError) return new Text(theme.fg("error", output || "error"), 0, 0);
      if (isPartial) {
        if (!output?.trim()) return new Text(theme.fg("muted", "\u2807 tailing\u2026"), 0, 0);
        return new Text(renderOutput(output, expanded, theme), 0, 0);
      }
      const rendered = renderOutput(output, expanded, theme);
      return rendered ? new Text(rendered, 0, 0) : undefined;
    },

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const grepRe = params.grep ? new RegExp(params.grep) : undefined;

      // Show live terminal widget when following
      const liveWidget: LiveWidget = { panelName: params.name, startedAt: Date.now(), disposed: false };
      if (params.follow && ctx?.hasUI) {
        liveWidget.timer = setTimeout(() => showLiveWidget(ctx, _toolCallId, liveWidget), LIVE_WIDGET_DELAY_MS);
      }

      const lines: string[] = [];
      let result: RunResult;
      try {
        result = await amuxTail(params.name, {
          follow: params.follow,
          lines: params.lines,
          timeout: params.timeout ?? 60,
          offset: params.offset,
          grep: grepRe,
          signal,
          onLine: (line) => {
            lines.push(line);
            onUpdate?.({ content: [{ type: "text", text: lines.join("\n") }] });
          },
        });
      } finally {
        hideLiveWidget(ctx, _toolCallId, liveWidget);
      }

      let text = lines.join("\n");

      let suffix = "";
      if (result.aborted) {
        suffix = `\n\n⊘ aborted \u2014 continue with:\n  amux_tail(name: "${params.name}", follow: true, offset: ${result.endPos})`;
      } else if (result.timedOut) {
        suffix = `\n\n\u23f3 timeout ${params.timeout ?? 60}s \u2014 continue with:\n  amux_tail(name: "${params.name}", follow: true, offset: ${result.endPos})`;
      } else if (result.exitCode !== undefined) {
        suffix = result.exitCode === 0 ? "\n\nSUCCESS" : `\n\nFAIL EXITCODE:${result.exitCode}`;
      }

      const fullText = text + suffix;
      const truncated = truncateTail(text);
      const llmText = truncated.content + suffix;

      return {
        content: [{ type: "text", text: llmText || "(empty)" }],
        details: { panel: params.name, follow: !!params.follow, lines: params.lines ?? 10, offset: params.offset, endPos: result.endPos, fullOutput: fullText },
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
      const name = args.name || "\u2026";
      const keys = (args.keys || []).map((k: string) => {
        if (/^C-.|^Enter$|^Tab$|^Esc$|^Space$|^BSpace$|^Up$|^Down$|^Left$|^Right$/.test(k)) return theme.fg("warning", k);
        return theme.fg("toolOutput", k);
      }).join(theme.fg("dim", " "));
      return new Text(theme.fg("dim", "amux ") + theme.fg("accent", theme.bold(name)) + theme.fg("dim", " \u00b7 \u2328 ") + keys, 0, 0);
    },

    renderResult(result, { expanded, isPartial }, theme) {
      if (isPartial) return new Text(theme.fg("muted", "\u2807 sending\u2026"), 0, 0);
      const output = getTextContent(result);
      if (result.isError) return new Text(theme.fg("error", output || "error"), 0, 0);
      const rendered = renderOutput(output, expanded, theme);
      return rendered ? new Text(rendered, 0, 0) : undefined;
    },

    async execute(_toolCallId, params) {
      const lines: string[] = [];
      const result = await amuxSendKeys(params.name, params.keys, {
        timeout: params.timeout ?? 5,
      });
      // Read recent output after keys
      const tailLines: string[] = [];
      await amuxTail(params.name, { lines: 10, onLine: (l) => tailLines.push(l) });
      return {
        content: [{ type: "text", text: tailLines.join("\n") || "(no output)" }],
        details: { panel: params.name, keys: params.keys },
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
      return new Text(theme.fg("dim", "amux ") + theme.fg("accent", theme.bold(args.name || "\u2026")) + theme.fg("dim", " \u00b7 kill"), 0, 0);
    },

    renderResult(result, { isPartial }, theme) {
      if (isPartial) return undefined;
      const name = result.details?.panel || "panel";
      if (result.isError) return new Text(theme.fg("error", getTextContent(result) || "error"), 0, 0);
      return new Text(theme.fg("success", "\u2713") + theme.fg("dim", ` ${name} removed`), 0, 0);
    },

    async execute(_toolCallId, params) {
      await amuxKill(params.name);
      if (trailPanel === params.name && lastCtx) hideTrail(lastCtx);
      delete panelBlinkUntil[params.name];
      delete panelLogSizes[params.name];
      return {
        content: [{ type: "text", text: `killed ${params.name}` }],
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
      return new Text(theme.fg("dim", "amux \u00b7 list"), 0, 0);
    },

    renderResult(result, { isPartial }, theme) {
      if (isPartial) return undefined;
      const output = getTextContent(result).trim();
      if (result.isError) return new Text(theme.fg("error", output || "error"), 0, 0);
      if (!output || output === "no panels") return new Text(theme.fg("dim", "no panels"), 0, 0);
      return new Text(output.split("\n").map((l) => theme.fg("toolOutput", l)).join("\n"), 0, 0);
    },

    async execute() {
      const allPanes = await amuxPanels();
      if (allPanes.length === 0) return { content: [{ type: "text", text: "no panels" }], details: {} };
      const byTab: Record<string, string[]> = {};
      for (const p of allPanes) {
        const tab = p.windowName || "?";
        if (!byTab[tab]) byTab[tab] = [];
        byTab[tab].push(p.paneName);
      }
      const lines: string[] = [];
      for (const [tab, names] of Object.entries(byTab)) {
        lines.push(`${tab}/`);
        for (const n of names) lines.push(`  ${n}`);
      }
      return { content: [{ type: "text", text: lines.join("\n") }], details: {} };
    },
  });

  // --- command: /amux ---

  pi.registerCommand("amux", {
    description: "Manage amux \u2014 /amux <panel> (trail), /amux (toggle trail)",
    handler: async (args, ctx) => {
      updateSessionTab(ctx);
      refreshTabBar();
      const sub = args.trim();
      if (sub) {
        const match = trailCachedPanels.find((p) => p.name === sub);
        if (match) { showTrail(ctx, match.name); return; }
        // Not an existing panel — create and trail
        await ensurePanel(sub);
        showTrail(ctx, sub);
        return;
      }
      if (trailCachedPanels.length === 0) { ctx.ui.notify("No amux panels in this session", "info"); return; }
      if (trailPanel) hideTrail(ctx);
      else showTrail(ctx, (trailCachedPanels.find((p) => p.hot) || trailCachedPanels[0]).name);
    },
  });
}
