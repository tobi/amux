/**
 * amux — pi extension
 *
 * Tools for running background tasks in named tmux panels.
 * Status bar shows active panels with pulsing on live output.
 * ⌥1..9 opens panel viewer overlay.
 * Activity detection via fs.watch on ~/.amux/panels/*.log.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { keyHint } from "@mariozechner/pi-coding-agent";
import { Text, Container, matchesKey, Key, truncateToWidth } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { readdirSync, statSync, watch as fsWatch, mkdirSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { FSWatcher } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PANEL_DIR = join(homedir(), ".amux", "panels");
const HOT_MS = 5000;

// -- amux CLI helper ----------------------------------------------------------

function amuxBin(): string {
  return join(__dirname, "..", "bin", "amux");
}

function amux(args: string[], timeout = 10): { stdout: string; exitCode: number } {
  const result = spawnSync("bun", [amuxBin(), ...args], {
    encoding: "utf-8",
    timeout: timeout * 1000,
    stdio: ["pipe", "pipe", "pipe"],
  });
  return {
    stdout: (result.stdout ?? "") + (result.stderr ?? ""),
    exitCode: result.status ?? 1,
  };
}

// -- panel discovery from filesystem ------------------------------------------

interface PanelState {
  name: string;
  hot: boolean;
}

function discoverPanels(): PanelState[] {
  try {
    const files = readdirSync(PANEL_DIR);
    const now = Date.now();
    const panels: PanelState[] = [];
    for (const f of files) {
      if (!f.endsWith(".log")) continue;
      const name = basename(f, ".log");
      try {
        const st = statSync(join(PANEL_DIR, f));
        panels.push({ name, hot: (now - st.mtimeMs) < HOT_MS });
      } catch {
        panels.push({ name, hot: false });
      }
    }
    return panels.sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

// -- status bar ---------------------------------------------------------------

let lastCtx: ExtensionContext | null = null;
let dirWatcher: FSWatcher | null = null;
let cooldownTimer: ReturnType<typeof setTimeout> | null = null;

function updateStatus(): void {
  const ctx = lastCtx;
  if (!ctx?.hasUI) return;

  const theme = ctx.ui.theme;
  const panels = discoverPanels();

  if (panels.length === 0) {
    ctx.ui.setStatus("amux", undefined);
    return;
  }

  const parts: string[] = [];
  panels.forEach((p, i) => {
    const n = i + 1;
    const tag = n <= 9 ? `⌥${n}:` : "";
    if (p.hot) {
      parts.push(theme.fg("muted", tag) + theme.bold(theme.fg("success", p.name)));
    } else {
      parts.push(theme.fg("muted", tag) + theme.fg("dim", p.name));
    }
  });

  ctx.ui.setStatus("amux", theme.fg("muted", "amux ") + parts.join(theme.fg("muted", " ")));
}

function scheduleUpdate(): void {
  if (cooldownTimer) return;
  updateStatus();
  cooldownTimer = setTimeout(() => { cooldownTimer = null; updateStatus(); }, 500);
}

function startWatching(ctx: ExtensionContext): void {
  lastCtx = ctx;
  stopWatching();
  mkdirSync(PANEL_DIR, { recursive: true });
  updateStatus();
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

// -- panel viewer overlay -----------------------------------------------------

function showPanelViewer(ctx: ExtensionContext, panelIndex: number): void {
  if (!ctx.hasUI) return;
  const panels = discoverPanels();
  if (panels.length === 0) { ctx.ui.notify("No amux panels", "info"); return; }

  const startIdx = Math.min(panelIndex, panels.length - 1);

  ctx.ui.custom<void>((tui, theme, _kb, done) => {
    let selectedIdx = startIdx;
    let content = "";
    let refreshTimer: ReturnType<typeof setInterval> | null = null;

    function loadContent(): void {
      const cur = discoverPanels();
      if (cur.length === 0) { done(); return; }
      if (selectedIdx >= cur.length) selectedIdx = cur.length - 1;
      const result = amux([cur[selectedIdx].name, "read"]);
      content = result.stdout.trim() || "(empty)";
    }

    function startRefresh(): void {
      if (refreshTimer) clearInterval(refreshTimer);
      refreshTimer = setInterval(() => { loadContent(); tui.requestRender(); }, 2000);
    }

    loadContent();
    startRefresh();

    return {
      render(width: number): string[] {
        const cur = discoverPanels();
        if (cur.length === 0) return ["(no panels)"];

        const lines: string[] = [];

        // Tab bar: ⌥1:server  ⌥2:build  ⌥3:test
        const tabs = cur.map((p, i) => {
          const key = theme.fg("muted", `⌥${i + 1}`);
          if (i === selectedIdx) {
            return key + theme.fg("accent", theme.bold(":" + p.name));
          }
          return key + theme.fg("dim", ":" + p.name);
        });
        lines.push(" " + tabs.join("  "));
        lines.push(theme.fg("dim", "─".repeat(width)));

        // Panel output
        const contentLines = content.split("\n");
        const maxLines = Math.max(1, (tui.screenHeight || 24) - 6);
        const visible = contentLines.slice(-maxLines);
        for (const line of visible) {
          lines.push(" " + truncateToWidth(theme.fg("toolOutput", line), width - 2));
        }

        // Footer
        lines.push(theme.fg("dim", "─".repeat(width)));
        lines.push(" " + theme.fg("dim", "⌥1-9 switch · esc close · refreshes every 2s"));

        return lines;
      },

      invalidate(): void {},

      handleInput(data: string): void {
        if (matchesKey(data, Key.escape)) {
          if (refreshTimer) clearInterval(refreshTimer);
          done();
          return;
        }
        for (let i = 1; i <= 9; i++) {
          if (matchesKey(data, Key.alt(String(i) as any))) {
            const cur = discoverPanels();
            if (i - 1 < cur.length) {
              selectedIdx = i - 1;
              loadContent();
              startRefresh();
              tui.requestRender();
            }
            return;
          }
        }
      },
    };
  });
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

  pi.on("session_start", (_event, ctx) => startWatching(ctx));
  pi.on("session_switch", (_event, ctx) => startWatching(ctx));
  pi.on("session_shutdown", () => stopWatching());
  pi.on("turn_end", (_event, ctx) => { lastCtx = ctx; updateStatus(); });

  // --- ⌥1..9 panel viewer ---

  for (let i = 1; i <= 9; i++) {
    pi.registerShortcut(Key.alt(String(i) as any), {
      description: `View amux panel ${i}`,
      handler: async (ctx) => showPanelViewer(ctx, i - 1),
    });
  }

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
      const t = args.timeout ? theme.fg("muted", ` -t${args.timeout}`) : "";
      return new Text(
        theme.fg("toolTitle", theme.bold("▶ " + name)) + theme.fg("dim", " $ ") + theme.fg("toolOutput", cmd) + t,
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
      const full = args.full ? theme.fg("muted", " --full") : "";
      return new Text(theme.fg("toolTitle", theme.bold("◀ " + name)) + full, 0, 0);
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
      const t = args.timeout ? theme.fg("muted", ` -t${args.timeout}`) : "";
      return new Text(theme.fg("toolTitle", theme.bold("⌨ " + name)) + " " + keys + t, 0, 0);
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
      return new Text(theme.fg("toolTitle", theme.bold("✕ " + (args.name || "…"))), 0, 0);
    },

    renderResult(result, { isPartial }, theme) {
      if (isPartial) return undefined;
      const name = result.details?.panel || "panel";
      if (result.isError) return new Text(theme.fg("error", getTextContent(result) || "error"), 0, 0);
      return new Text(theme.fg("success", "✓") + theme.fg("dim", ` ${name} removed`), 0, 0);
    },

    async execute(_toolCallId, params) {
      const result = amux([params.name, "kill"]);
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
      return new Text(theme.fg("toolTitle", theme.bold("☰ panels")), 0, 0);
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
    description: "Show amux panel status",
    handler: async (_args, ctx) => {
      const panels = discoverPanels();
      if (panels.length > 0) {
        ctx.ui.notify(`Active panels: ${panels.map((p) => p.name).join(", ")}`, "info");
      } else {
        ctx.ui.notify("No active amux panels", "info");
      }
    },
  });
}
