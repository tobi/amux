/**
 * amux — pi extension
 *
 * Gives the agent amux tools for running background tasks in named tmux panels.
 * Shows active panel status in the pi status bar.
 * Custom tool rendering for neat display of panel commands and output.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { keyHint } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// -- activity tracking --------------------------------------------------------

const CACHE_DIR = join(homedir(), ".amux", "cache");
const ACTIVITY_FILE = join(CACHE_DIR, "panel-activity.json");
const ACTIVE_WINDOW_MS = 3 * 60 * 1000; // 3 minutes

interface PanelActivity {
  [name: string]: number; // panel name → last activity timestamp (ms)
}

function loadActivity(): PanelActivity {
  try {
    if (existsSync(ACTIVITY_FILE)) {
      return JSON.parse(readFileSync(ACTIVITY_FILE, "utf-8"));
    }
  } catch {}
  return {};
}

function saveActivity(activity: PanelActivity): void {
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(ACTIVITY_FILE, JSON.stringify(activity));
}

function touchPanel(name: string): void {
  const activity = loadActivity();
  activity[name] = Date.now();
  saveActivity(activity);
}

function removePanel(name: string): void {
  const activity = loadActivity();
  delete activity[name];
  saveActivity(activity);
}

function activePanels(): string[] {
  const activity = loadActivity();
  const cutoff = Date.now() - ACTIVE_WINDOW_MS;
  return Object.entries(activity)
    .filter(([, ts]) => ts > cutoff)
    .sort((a, b) => b[1] - a[1])
    .map(([name]) => name);
}

// -- amux helpers (shell out to the amux CLI) ---------------------------------

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

// -- rendering helpers --------------------------------------------------------

const PREVIEW_LINES = 5;

function renderOutput(
  output: string,
  expanded: boolean,
  theme: any,
): string {
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

// -- status bar ---------------------------------------------------------------

function updateStatus(ctx: ExtensionContext): void {
  if (!ctx.hasUI) return;
  const theme = ctx.ui.theme;
  const names = activePanels();

  if (names.length === 0) {
    ctx.ui.setStatus("amux", undefined);
    return;
  }

  const label = theme.fg("dim", "amux ");
  const panelList = names.map((n) => theme.fg("accent", n)).join(theme.fg("dim", " · "));
  ctx.ui.setStatus("amux", label + panelList);
}

// -- extension ----------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  // --- status bar on session events ---

  pi.on("session_start", (_event, ctx) => {
    updateStatus(ctx);
  });

  pi.on("session_switch", (_event, ctx) => {
    updateStatus(ctx);
  });

  pi.on("turn_end", (_event, ctx) => {
    updateStatus(ctx);
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
      const t = args.timeout ? theme.fg("muted", ` -t${args.timeout}`) : "";
      return new Text(
        theme.fg("toolTitle", theme.bold("▶ " + name)) + theme.fg("dim", " $ ") + theme.fg("toolOutput", cmd) + t,
        0, 0,
      );
    },

    renderResult(result, { expanded, isPartial }, theme) {
      if (isPartial) {
        return new Text(theme.fg("muted", "⠿ running…"), 0, 0);
      }
      const output = (result.content || [])
        .filter((c: any) => c.type === "text")
        .map((c: any) => c.text || "")
        .join("\n");
      if (result.isError) {
        return new Text(theme.fg("error", output || "error"), 0, 0);
      }
      const rendered = renderOutput(output, expanded, theme);
      return rendered ? new Text(rendered, 0, 0) : undefined;
    },

    async execute(_toolCallId, params) {
      const { name, command, timeout } = params;
      const t = timeout ?? 5;
      const result = amux([name, "shell", command, `-t${t}`], t + 5);
      touchPanel(name);
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
      return new Text(
        theme.fg("toolTitle", theme.bold("◀ " + name)) + full,
        0, 0,
      );
    },

    renderResult(result, { expanded, isPartial }, theme) {
      if (isPartial) {
        return new Text(theme.fg("muted", "⠿ reading…"), 0, 0);
      }
      const output = (result.content || [])
        .filter((c: any) => c.type === "text")
        .map((c: any) => c.text || "")
        .join("\n");
      if (result.isError) {
        return new Text(theme.fg("error", output || "error"), 0, 0);
      }
      const rendered = renderOutput(output, expanded, theme);
      return rendered ? new Text(rendered, 0, 0) : undefined;
    },

    async execute(_toolCallId, params) {
      const args = [params.name, "read"];
      if (params.full) args.push("--full");
      const result = amux(args);
      touchPanel(params.name);
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
        // Style special keys differently from literal text
        if (/^C-.|^Enter$|^Tab$|^Esc$|^Space$|^BSpace$|^Up$|^Down$|^Left$|^Right$/.test(k)) {
          return theme.fg("warning", k);
        }
        return theme.fg("toolOutput", k);
      }).join(theme.fg("dim", " "));
      const t = args.timeout ? theme.fg("muted", ` -t${args.timeout}`) : "";
      return new Text(
        theme.fg("toolTitle", theme.bold("⌨ " + name)) + " " + keys + t,
        0, 0,
      );
    },

    renderResult(result, { expanded, isPartial }, theme) {
      if (isPartial) {
        return new Text(theme.fg("muted", "⠿ sending…"), 0, 0);
      }
      const output = (result.content || [])
        .filter((c: any) => c.type === "text")
        .map((c: any) => c.text || "")
        .join("\n");
      if (result.isError) {
        return new Text(theme.fg("error", output || "error"), 0, 0);
      }
      const rendered = renderOutput(output, expanded, theme);
      return rendered ? new Text(rendered, 0, 0) : undefined;
    },

    async execute(_toolCallId, params) {
      const { name, keys, timeout } = params;
      const t = timeout ?? 5;
      const result = amux([name, "send-keys", ...keys, `-t${t}`], t + 5);
      touchPanel(name);
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
      const name = args.name || "…";
      return new Text(
        theme.fg("toolTitle", theme.bold("✕ " + name)),
        0, 0,
      );
    },

    renderResult(result, { isPartial }, theme) {
      if (isPartial) return undefined;
      const name = result.details?.panel || "panel";
      if (result.isError) {
        const output = (result.content || []).map((c: any) => c.text || "").join("\n");
        return new Text(theme.fg("error", output || "error"), 0, 0);
      }
      return new Text(theme.fg("success", "✓") + theme.fg("dim", ` ${name} removed`), 0, 0);
    },

    async execute(_toolCallId, params) {
      const result = amux([params.name, "kill"]);
      removePanel(params.name);
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
        theme.fg("toolTitle", theme.bold("☰ panels")),
        0, 0,
      );
    },

    renderResult(result, { isPartial }, theme) {
      if (isPartial) return undefined;
      const output = (result.content || [])
        .filter((c: any) => c.type === "text")
        .map((c: any) => c.text || "")
        .join("\n")
        .trim();
      if (result.isError) {
        return new Text(theme.fg("error", output || "error"), 0, 0);
      }
      if (!output || output === "no panels") {
        return new Text(theme.fg("dim", "no panels"), 0, 0);
      }
      // Format panel list nicely
      const lines = output.split("\n").map((line) => {
        const parts = line.trim().split(/\t+/);
        if (parts.length >= 2) {
          const idx = parts[0];
          const name = parts[1];
          return theme.fg("muted", idx + " ") + theme.fg("accent", name);
        }
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
    description: "Show amux panel status or run `amux watch` to attach",
    handler: async (args, ctx) => {
      if (args?.trim() === "watch") {
        ctx.ui.notify("Run `amux watch` in a separate terminal to see panels live", "info");
        return;
      }
      const result = amux(["list"]);
      const active = activePanels();
      if (active.length > 0) {
        ctx.ui.notify(`Active panels: ${active.join(", ")}`, "info");
      } else {
        ctx.ui.notify("No active amux panels", "info");
      }
    },
  });
}
