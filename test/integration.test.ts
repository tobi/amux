import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { isolate, waitForOutput } from "./helpers.ts";
import {
  config, hasSession, ensureSession, terminate, ensurePanel,
  findPanel, panels, windowMap, list, kill, read,
  shell, sendKeys, saveTimeoutLog,
  PanelNotFound, InvalidPanelName, AmuxError,
} from "../src/amux.ts";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";

// -- helpers ------------------------------------------------------------------

// Capture stdout/stderr from a sync function.
// Patches both .write and console.log/error (which bypass .write in Bun).
function captureIO(fn: () => void): { stdout: string; stderr: string } {
  const origOutWrite = process.stdout.write;
  const origErrWrite = process.stderr.write;
  const origLog = console.log;
  const origError = console.error;
  let stdout = "";
  let stderr = "";
  process.stdout.write = (chunk: any) => {
    stdout += String(chunk);
    return true;
  };
  process.stderr.write = (chunk: any) => {
    stderr += String(chunk);
    return true;
  };
  console.log = (...args: any[]) => {
    stdout += args.map(String).join(" ") + "\n";
  };
  console.error = (...args: any[]) => {
    stderr += args.map(String).join(" ") + "\n";
  };
  try {
    fn();
  } finally {
    process.stdout.write = origOutWrite;
    process.stderr.write = origErrWrite;
    console.log = origLog;
    console.error = origError;
  }
  return { stdout, stderr };
}

// -- session lifecycle --------------------------------------------------------

describe("session lifecycle", () => {
  const iso = isolate("session");
  beforeEach(iso.setup);
  afterEach(iso.teardown);

  test("no session initially", () => {
    expect(hasSession()).toBe(false);
  });

  test("ensureSession creates session", () => {
    ensureSession();
    expect(hasSession()).toBe(true);
  });

  test("terminate destroys session", () => {
    ensureSession();
    expect(hasSession()).toBe(true);
    terminate();
    Bun.sleepSync(200);
    expect(hasSession()).toBe(false);
  });
});

// -- panel lifecycle ----------------------------------------------------------

describe("panel lifecycle", () => {
  const iso = isolate("panels");
  beforeEach(iso.setup);
  afterEach(iso.teardown);

  test("panels empty initially", () => {
    ensureSession();
    expect(Object.keys(panels())).toEqual([]);
  });

  test("ensurePanel creates and renames init", () => {
    const id = ensurePanel("myapp");
    expect(id).toBeTruthy();
    expect(findPanel("myapp")).toBeTruthy();
    expect(findPanel(config.initPanel)).toBeUndefined();
  });

  test("ensurePanel is quiet", () => {
    const { stderr } = captureIO(() => ensurePanel("hinted"));
    expect(stderr).toBe("");
  });

  test("second panel is a new window", () => {
    ensurePanel("first");
    ensurePanel("second");
    const p = panels();
    expect(p["first"]).toBeTruthy();
    expect(p["second"]).toBeTruthy();
    expect(Object.keys(p).length).toBe(2);
  });

  test("ensurePanel is idempotent", () => {
    const id1 = ensurePanel("myapp");
    const id2 = ensurePanel("myapp");
    expect(id1).toBe(id2);
  });

  test("kill removes panel", () => {
    ensurePanel("ephemeral");
    expect(findPanel("ephemeral")).toBeTruthy();
    kill("ephemeral");
    Bun.sleepSync(200);
    expect(findPanel("ephemeral")).toBeUndefined();
  });

  test("kill nonexistent is noop", () => {
    ensureSession();
    expect(() => kill("ghost")).not.toThrow();
  });

  test("list shows panels", () => {
    ensurePanel("alpha");
    ensurePanel("beta");
    const { stdout } = captureIO(() => list());
    expect(stdout).toContain("alpha");
    expect(stdout).toContain("beta");
  });

  test("list empty", () => {
    ensureSession();
    const { stdout } = captureIO(() => list());
    expect(stdout).toContain("no panels");
  });
});

// -- panel name validation ----------------------------------------------------

describe("panel name validation", () => {
  const iso = isolate("validation");
  beforeEach(iso.setup);
  afterEach(iso.teardown);

  test("rejects empty name", () => {
    expect(() => ensurePanel("")).toThrow(InvalidPanelName);
  });

  test("rejects spaces", () => {
    expect(() => ensurePanel("my app")).toThrow(InvalidPanelName);
  });

  test("rejects colons", () => {
    expect(() => ensurePanel("host:port")).toThrow(InvalidPanelName);
  });

  test("rejects dots", () => {
    expect(() => ensurePanel("v1.2")).toThrow(InvalidPanelName);
  });

  test("rejects slashes", () => {
    expect(() => ensurePanel("path/to")).toThrow(InvalidPanelName);
  });

  test("rejects reserved init panel", () => {
    expect(() => ensurePanel(config.initPanel)).toThrow(InvalidPanelName);
  });

  test("allows alphanumeric-dash-underscore", () => {
    const id = ensurePanel("my-app_v2");
    expect(id).toBeTruthy();
    expect(findPanel("my-app_v2")).toBeTruthy();
  });
});

// -- shell & read -------------------------------------------------------------

describe("shell and read", () => {
  const iso = isolate("shell-read");
  beforeEach(iso.setup);
  afterEach(iso.teardown);

  test("shell runs command, read captures output", () => {
    shell("worker", "echo HELLO_AMUX_TEST");
    const output = waitForOutput("worker", /HELLO_AMUX_TEST/);
    expect(output).toContain("HELLO_AMUX_TEST");
  });

  test("read full scrollback", () => {
    shell("logger", "for i in $(seq 1 5); do echo line_$i; done");
    waitForOutput("logger", /line_5/);
    const full = read("logger", { full: true });
    for (let i = 1; i <= 5; i++) {
      expect(full).toContain(`line_${i}`);
    }
  });

  test("read nonexistent panel throws", () => {
    ensureSession();
    expect(() => read("nonexistent")).toThrow(PanelNotFound);
  });

  test("shell empty command throws", () => {
    expect(() => shell("x", "")).toThrow(AmuxError);
  });
});

// -- send-keys ----------------------------------------------------------------

describe("sendKeys", () => {
  const iso = isolate("send-keys");
  beforeEach(iso.setup);
  afterEach(iso.teardown);

  test("literal text and Enter", () => {
    ensurePanel("repl");
    Bun.sleepSync(500);
    sendKeys("repl", ["echo KEYTEST", "Enter"]);
    const output = waitForOutput("repl", /KEYTEST/);
    expect(output).toContain("KEYTEST");
  });

  test("Ctrl-C interrupts", () => {
    shell("sleeper", "sleep 999");
    Bun.sleepSync(300);
    sendKeys("sleeper", ["C-c"]);
    Bun.sleepSync(500);
    const output = read("sleeper");
    expect(output).toContain("sleeper");
  });
});

// -- streaming ----------------------------------------------------------------

describe("streaming", () => {
  const iso = isolate("streaming");
  beforeEach(iso.setup);
  afterEach(iso.teardown);

  test("captures output with timeout", () => {
    const { stdout } = captureIO(() => {
      shell("streamer", "echo STREAM_OK", { timeout: 3 });
    });
    expect(stdout).toContain("STREAM_OK");
  });

  test("detects ready sequence and stops early", () => {
    const start = performance.now();
    captureIO(() => {
      shell("quick", "echo done", { timeout: 30 });
    });
    const elapsed = (performance.now() - start) / 1000;
    expect(elapsed).toBeLessThan(10);
  });
});

// -- window map ---------------------------------------------------------------

describe("windowMap", () => {
  const iso = isolate("window-map");
  beforeEach(iso.setup);
  afterEach(iso.teardown);

  test("includes all windows", () => {
    ensurePanel("one");
    ensurePanel("two");
    ensurePanel("three");
    const wm = windowMap();
    expect(wm["one"]).toBeTruthy();
    expect(wm["two"]).toBeTruthy();
    expect(wm["three"]).toBeTruthy();
    for (const meta of Object.values(wm)) {
      expect(meta.id).toBeTruthy();
      expect(typeof meta.index).toBe("number");
    }
  });
});

// -- timeout log --------------------------------------------------------------

describe("saveTimeoutLog", () => {
  const iso = isolate("timeout-log");
  beforeEach(iso.setup);
  afterEach(iso.teardown);

  test("creates file with content", () => {
    saveTimeoutLog("raw data here", "test-panel", "stream");
    const files = readdirSync(config.logDir).filter((f) =>
      f.startsWith("test-panel-stream-")
    );
    expect(files.length).toBe(1);
    expect(readFileSync(join(config.logDir, files[0]), "utf-8")).toBe(
      "raw data here"
    );
  });
});
