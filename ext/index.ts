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
import { spawnSync } from "node:child_process";
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
  const result = spawnSync("which", ["amux"], { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
  return result.status === 0;
}

function amux(args: string[], timeout = 10): { stdout: string; exitCode: number } {
  const result = spawnSync(amuxBin(), args, {
    encoding: "utf-8",
    timeout: timeout * 1000,
    stdio: ["pipe", "pipe", "pipe"],
  });
  return {
    stdout: (result.stdout ?? "") + (result.stderr ?? ""),
    exitCode: result.status ?? 1,
  };
}

/** Fire a command into a panel without waiting for output. */
function amuxFireAndForget(name: string, command: string): void {
  spawnSync(amuxBin(), [name, "shell", command, "-t0"], {
    encoding: "utf-8",
    timeout: 5000,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

// -- panel discovery from filesystem ------------------------------------------

interface PanelState {
  name: string;
  hot: boolean;
  cwd: string | undefined;
}

function discoverAllPanels(): PanelState[] {
  try {
    const files = readdirSync(PANEL_DIR);
    const now = Date.now();
    const panels: PanelState[] = [];
    for (const f of files) {
      if (!f.endsWith(".log")) continue;
      const name = basename(f, ".log");
      let hot = false;
      try {
        const st = statSync(join(PANEL_DIR, f));
        hot = (now - st.mtimeMs) < HOT_MS;
      } catch {}
      let cwd: string | undefined;
      try {
        cwd = readFileSync(join(PANEL_DIR, `${name}.cwd`), "utf-8").trim() || undefined;
      } catch {}
      panels.push({ name, hot, cwd });
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

      // Tab bar — "Amux" label, tabs separated by ·, trailed tab highlighted
      const tabs = all.map((p, i) => {
        const n = i + 1;
        const hotDot = p.hot ? blueFg("●") : "";
        if (p.name === activeName) {
          // Trailed: blue bg, black text
          const label = n <= 9 ? ` ⌥${n} ${p.name} ` : ` ${p.name} `;
          return blueBgBlack(label) + hotDot;
        }
        const key = n <= 9 ? blueDim(`⌥${n} `) : "";
        const label = p.name;
        if (p.hot) {
          return key + blueFg(label) + " " + hotDot;
        }
        return key + blueDim(label);
      });
      const sep = blueDim(" · ");
      const left = " " + tealDim("amux") + "  " + tabs.join(sep);
      const hint = activeName ? blueDim("⌥K kill") : "";
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
        if (snapPanels !== trailCachedPanels || snapOutput !== trailCachedOutput || snapActive !== trailPanel) {
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

export default function (pi: ExtensionAPI) {

  // --- lifecycle ---

  pi.on("session_start", (_event, ctx) => {
    lastCtx = ctx;
    startWatching(ctx);
    if (!amuxOnPath()) {
      ctx.ui.notify(
        "amux is not on your PATH. Run /amux install or: npm i -g amux",
        "warning",
      );
    }

    // Initialize tab bar — auto-trail hot panel if any
    const existing = discoverAllPanels();
    const hot = existing.find((p) => p.hot);
    if (hot) {
      showTrail(ctx, hot.name);
    } else if (existing.length > 0) {
      showTrail(ctx, existing[0].name);
    } else {
      refreshTabBar();
      startTrailRefresh(ctx);
    }
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
      amux([name, "kill"]);
      hideTrail(ctx);
      ctx.ui.notify(`killed ${name}`, "info");
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
      "After starting a background process, use amux_read to check on it later.",
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

    async execute(_toolCallId, params) {
      const { name, command, timeout } = params;
      const t = timeout ?? 5;

      // Auto-show trailing for this panel
      if (lastCtx?.hasUI) {
        showTrail(lastCtx, name);
      }

      const result = amux([name, "shell", command, `-t${t}`], t + 5);
      return {
        content: [{ type: "text", text: result.stdout || "(no output)" }],
        details: { panel: name, command, exitCode: result.exitCode },
      };
    },
  });

  // --- tool: amux_read ---

  pi.registerTool({
    name: "amux_read",
    label: "amux read",
    description: "Capture the current screen buffer of a named panel. Use --full for complete scrollback.",
    promptSnippet: "Read output from a named background panel (amux read NAME)",
    parameters: Type.Object({
      name: Type.String({ description: "Panel name" }),
      full: Type.Optional(Type.Boolean({ description: "Read full scrollback instead of just the visible screen" })),
    }),

    renderCall(args, theme) {
      const name = args.name || "…";
      const full = args.full ? theme.fg("dim", " --full") : "";
      return new Text(
        theme.fg("dim", "amux ") + theme.fg("accent", theme.bold(name)) + theme.fg("dim", " · read") + full,
        0, 0,
      );
    },

    renderResult(result, { expanded, isPartial }, theme) {
      if (isPartial) return new Text(theme.fg("muted", "⠿ reading…"), 0, 0);
      const output = getTextContent(result);
      if (result.isError) return new Text(theme.fg("error", output || "error"), 0, 0);
      const rendered = renderOutput(output, expanded, theme);
      return rendered ? new Text(rendered, 0, 0) : undefined;
    },

    async execute(_toolCallId, params) {
      const args = [params.name, "read"];
      if (params.full) args.push("--full");
      const result = amux(args);
      return {
        content: [{ type: "text", text: result.stdout || "(empty)" }],
        details: { panel: params.name, full: !!params.full },
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

    async execute(_toolCallId, params) {
      const { name, keys, timeout } = params;
      const t = timeout ?? 5;
      const result = amux([name, "send-keys", ...keys, `-t${t}`], t + 5);
      return {
        content: [{ type: "text", text: result.stdout || "(no output)" }],
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
      const result = amux([params.name, "kill"]);
      if (trailPanel === params.name && lastCtx) {
        hideTrail(lastCtx);
      }
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
      const result = amux(["list"]);
      return {
        content: [{ type: "text", text: result.stdout || "no panels" }],
        details: {},
      };
    },
  });

  // --- command: /amux ---

  pi.registerCommand("amux", {
    description: "Manage amux — /amux (toggle trail), /amux install (add to PATH), /amux <cmd> (run in shell panel)",
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

      // /amux <shell command> — fire into "shell" panel, show trail
      if (sub) {
        amuxFireAndForget("shell", sub);
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
