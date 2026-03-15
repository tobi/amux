import { describe, test, beforeEach, afterEach } from "node:test";
import { strict as assert } from "node:assert";
import { isolate, waitForOutput, sleepSync } from "./helpers.ts";
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
// Patches both .write and console.log/error.
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
    assert.equal(hasSession(), false);
  });

  test("ensureSession creates session", () => {
    ensureSession();
    assert.equal(hasSession(), true);
  });

  test("terminate destroys session", () => {
    ensureSession();
    assert.equal(hasSession(), true);
    terminate();
    sleepSync(200);
    assert.equal(hasSession(), false);
  });
});

// -- panel lifecycle ----------------------------------------------------------

describe("panel lifecycle", () => {
  const iso = isolate("panels");
  beforeEach(iso.setup);
  afterEach(iso.teardown);

  test("panels empty initially", () => {
    ensureSession();
    assert.deepEqual(Object.keys(panels()), []);
  });

  test("ensurePanel creates and renames init", () => {
    const id = ensurePanel("myapp");
    assert.ok(id);
    assert.ok(findPanel("myapp"));
    assert.equal(findPanel(config.initPanel), undefined);
  });

  test("ensurePanel is quiet", () => {
    const { stderr } = captureIO(() => ensurePanel("hinted"));
    assert.equal(stderr, "");
  });

  test("second panel is a new window", () => {
    ensurePanel("first");
    ensurePanel("second");
    const p = panels();
    assert.ok(p["first"]);
    assert.ok(p["second"]);
    assert.equal(Object.keys(p).length, 2);
  });

  test("ensurePanel is idempotent", () => {
    const id1 = ensurePanel("myapp");
    const id2 = ensurePanel("myapp");
    assert.equal(id1, id2);
  });

  test("kill removes panel", () => {
    ensurePanel("ephemeral");
    assert.ok(findPanel("ephemeral"));
    kill("ephemeral");
    sleepSync(200);
    assert.equal(findPanel("ephemeral"), undefined);
  });

  test("kill nonexistent is noop", () => {
    ensureSession();
    assert.doesNotThrow(() => kill("ghost"));
  });

  test("list shows panels", () => {
    ensurePanel("alpha");
    ensurePanel("beta");
    const { stdout } = captureIO(() => list());
    assert.ok(stdout.includes("alpha"));
    assert.ok(stdout.includes("beta"));
  });

  test("list empty", () => {
    ensureSession();
    const { stdout } = captureIO(() => list());
    assert.ok(stdout.includes("no panels"));
  });
});

// -- panel name validation ----------------------------------------------------

describe("panel name validation", () => {
  const iso = isolate("validation");
  beforeEach(iso.setup);
  afterEach(iso.teardown);

  test("rejects empty name", () => {
    assert.throws(() => ensurePanel(""), (e: any) => e instanceof InvalidPanelName);
  });

  test("rejects spaces", () => {
    assert.throws(() => ensurePanel("my app"), (e: any) => e instanceof InvalidPanelName);
  });

  test("rejects colons", () => {
    assert.throws(() => ensurePanel("host:port"), (e: any) => e instanceof InvalidPanelName);
  });

  test("rejects dots", () => {
    assert.throws(() => ensurePanel("v1.2"), (e: any) => e instanceof InvalidPanelName);
  });

  test("rejects slashes", () => {
    assert.throws(() => ensurePanel("path/to"), (e: any) => e instanceof InvalidPanelName);
  });

  test("rejects reserved init panel", () => {
    assert.throws(() => ensurePanel(config.initPanel), (e: any) => e instanceof InvalidPanelName);
  });

  test("allows alphanumeric-dash-underscore", () => {
    const id = ensurePanel("my-app_v2");
    assert.ok(id);
    assert.ok(findPanel("my-app_v2"));
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
    assert.ok(output.includes("HELLO_AMUX_TEST"));
  });

  test("read full scrollback", () => {
    shell("logger", "for i in $(seq 1 5); do echo line_$i; done");
    waitForOutput("logger", /line_5/);
    const full = read("logger", { full: true });
    for (let i = 1; i <= 5; i++) {
      assert.ok(full.includes(`line_${i}`));
    }
  });

  test("read nonexistent panel throws", () => {
    ensureSession();
    assert.throws(() => read("nonexistent"), (e: any) => e instanceof PanelNotFound);
  });

  test("shell empty command throws", () => {
    assert.throws(() => shell("x", ""), (e: any) => e instanceof AmuxError);
  });
});

// -- send-keys ----------------------------------------------------------------

describe("sendKeys", () => {
  const iso = isolate("send-keys");
  beforeEach(iso.setup);
  afterEach(iso.teardown);

  test("literal text and Enter", () => {
    ensurePanel("repl");
    sleepSync(500);
    sendKeys("repl", ["echo KEYTEST", "Enter"]);
    const output = waitForOutput("repl", /KEYTEST/);
    assert.ok(output.includes("KEYTEST"));
  });

  test("Ctrl-C interrupts", () => {
    shell("sleeper", "sleep 999");
    sleepSync(300);
    sendKeys("sleeper", ["C-c"]);
    sleepSync(500);
    const output = read("sleeper");
    assert.ok(output.includes("sleeper"));
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
    assert.ok(stdout.includes("STREAM_OK"));
  });

  test("detects ready sequence and stops early", () => {
    const start = performance.now();
    captureIO(() => {
      shell("quick", "echo done", { timeout: 30 });
    });
    const elapsed = (performance.now() - start) / 1000;
    assert.ok(elapsed < 10);
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
    assert.ok(wm["one"]);
    assert.ok(wm["two"]);
    assert.ok(wm["three"]);
    for (const meta of Object.values(wm)) {
      assert.ok(meta.id);
      assert.equal(typeof meta.index, "number");
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
    assert.equal(files.length, 1);
    assert.equal(readFileSync(join(config.logDir, files[0]), "utf-8"),
      "raw data here"
    );
  });
});
