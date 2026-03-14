/**
 * amux — pi extension
 *
 * Gives the agent amux tools for running background tasks in named tmux panels.
 * Shows active panel status in the pi status bar.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
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
