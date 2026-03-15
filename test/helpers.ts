// Test isolation for amux integration tests.
// Each test suite gets its own tmux socket so tests never collide
// with each other or a real amux session.

import { mkdtempSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import { spawnSync } from "child_process";
import { config, serverRunning, hasSession, read } from "../src/amux.ts";

// -- synchronous sleep (node-compatible) --------------------------------------

const sleepBuffer = new SharedArrayBuffer(4);
const sleepArray = new Int32Array(sleepBuffer);

export function sleepSync(ms: number): void {
  Atomics.wait(sleepArray, 0, 0, ms);
}

export interface SavedConfig {
  sessionName: string;
  initPanel: string;
  socketName: string;
  logDir: string;
}

let suiteCounter = 0;

export function isolate(suiteName: string): {
  setup: () => void;
  teardown: () => void;
} {
  let saved: SavedConfig;
  const id = `amux-test-${process.pid}-${++suiteCounter}-${suiteName.replace(/\W/g, "-")}`;

  return {
    setup() {
      saved = {
        sessionName: config.sessionName,
        initPanel: config.initPanel,
        socketName: config.socketName,
        logDir: config.logDir,
      };

      config.sessionName = "amux-test";
      config.initPanel = "_amux_test_init_";
      config.socketName = id;
      config.logDir = mkdtempSync(`${tmpdir()}/amux-test-logs-`);
    },

    teardown() {
      // Kill the test tmux server entirely
      if (serverRunning()) {
        spawnSync(
          "tmux", ["-L", config.socketName, "kill-server"],
          { stdio: ["ignore", "ignore", "ignore"] }
        );
        // Wait for socket to disappear
        for (let i = 0; i < 10; i++) {
          const sp = socketPathFor(config.socketName);
          if (!existsSync(sp)) break;
          sleepSync(100);
        }
      }

      try {
        rmSync(config.logDir, { recursive: true, force: true });
      } catch {}

      config.sessionName = saved.sessionName;
      config.initPanel = saved.initPanel;
      config.socketName = saved.socketName;
      config.logDir = saved.logDir;
    },
  };
}

function socketPathFor(socketName: string): string {
  const base = process.env.TMUX_TMPDIR || "/tmp";
  return `${base}/tmux-${process.getuid!()}/${socketName}`;
}

// Poll a panel's output until it matches a pattern
export function waitForOutput(
  panelName: string,
  pattern: RegExp,
  timeoutMs = 5000
): string {
  const deadline = performance.now() + timeoutMs;
  while (true) {
    let output: string;
    try {
      output = read(panelName, { full: true });
    } catch {
      output = "";
    }
    if (pattern.test(output)) return output;
    if (performance.now() >= deadline) {
      throw new Error(
        `timed out waiting for ${pattern} in panel '${panelName}'`
      );
    }
    sleepSync(150);
  }
}
