#!/usr/bin/env -S node --experimental-strip-types --experimental-transform-types --no-warnings

import {
  list, watch, panels, terminate, run, sendKeys, tail, panelGet, kill,
  ensureSession, AmuxError, MAX_TIMEOUT,
} from "../src/amux.ts";

const HELP = `amux — agentic mux

Named panels backed by tmux. Panels are panes tiled within a tab per cwd.

For humans:
  amux watch                see all tabs/panels live (Ctrl-Q to detach)
  amux watch -r             attach read-only
  amux list                 show active panels
  amux terminate --yes      shut down all panels

For agents:
  amux NAME run CMD...      run command, stream output (default: -t5)
  amux NAME tail [opts]     tail panel log (default: 10 lines, -t60)
  amux NAME panel-get       dump tmux panel screen (--full for scrollback)
  amux NAME send-keys K...  send keystrokes to a panel
  amux NAME kill            remove a single panel

Options:
  -tN                       timeout in seconds (max ${MAX_TIMEOUT})

tail options:
  --follow / -f             follow live output until done or timeout
  --lines=N                 number of tail lines (default: 10)
  -c OFFSET                 start from byte offset (continue after run timeout)

Workflow:
  amux server run "npm start"             # streams output, 5s default
  # if timeout: output shows continuation command with offset
  amux server tail -f -c 4820             # resume from where run stopped
  amux server tail                        # quick check: last 10 lines
`;

const args = process.argv.slice(2);
let timeoutOverride: number | undefined;
const tIdx = args.findIndex((a: string) => /^-t\d+$/.test(a));
if (tIdx !== -1) {
  timeoutOverride = Math.min(parseInt(args[tIdx].slice(2), 10), MAX_TIMEOUT);
  args.splice(tIdx, 1);
}

const COMMANDS = ["run", "shell", "tail", "read", "panel-get", "send-keys", "kill"];

async function main() {
  switch (args[0]) {
    case "list":
      await list();
      process.exit(0);

    case "terminate":
      if (!args.includes("--yes")) {
        const p = await panels();
        if (p.length > 0) {
          console.log("active panels:");
          for (const pane of p) console.log("  " + pane.windowName + "/" + pane.paneName + "\t" + pane.paneId);
        }
        process.stderr.write("confirm with: amux terminate --yes\n");
        process.exit(1);
      }
      await terminate();
      console.log("session destroyed");
      process.exit(0);

    case "watch":
    case "attach":
      await ensureSession();
      watch({ readonly: args.includes("-r") });
      break;

    case undefined:
    case "-h":
    case "--help":
    case "help":
      process.stderr.write(HELP);
      process.exit(0);
  }

  const name = args[0];
  const cmd = args[1];
  if (!cmd || !COMMANDS.includes(cmd)) {
    process.stderr.write(HELP);
    process.exit(1);
  }

  const rest = args.slice(2);

  switch (cmd) {
    case "run":
    case "shell": {
      const command = rest.length === 1 ? rest[0] : rest.join(" ");
      if (!command) { process.stderr.write(HELP); process.exit(1); }
      await run(name, command, { timeout: timeoutOverride ?? 5 });
      break;
    }
    case "send-keys": {
      if (rest.length === 0) { process.stderr.write(HELP); process.exit(1); }
      const result = await sendKeys(name, rest, { timeout: timeoutOverride ?? 5 });
      if (result.timedOut) {
        process.stdout.write("\n\u23f3 timeout — use `amux " + name + " tail` to check output.\n");
      }
      break;
    }
    case "tail":
    case "read": {
      const follow = rest.includes("--follow") || rest.includes("-f");
      let lines = 10;
      const la = rest.find((a: string) => a.startsWith("--lines="));
      if (la) lines = parseInt(la.split("=")[1], 10) || 10;
      let offset: number | undefined;
      const ci = rest.indexOf("-c");
      if (ci !== -1 && rest[ci + 1]) { offset = parseInt(rest[ci + 1], 10); if (isNaN(offset)) offset = undefined; }
      await tail(name, { follow, lines, timeout: timeoutOverride ?? 60, offset });
      break;
    }
    case "panel-get": {
      process.stdout.write(await panelGet(name, { full: rest.includes("--full") }));
      break;
    }
    case "kill": {
      await kill(name);
      console.log("- " + name);
      break;
    }
  }
}

main().catch((e) => {
  if (e instanceof AmuxError) {
    process.stderr.write("amux: " + e.message + "\n");
    process.exit(1);
  }
  throw e;
});
