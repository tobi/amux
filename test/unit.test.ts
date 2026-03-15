import { describe, test } from "node:test";
import { strict as assert } from "node:assert";
import {
  stripAnsi, normalizeKey, validatePanelName, socketPath, config,
  detectInputWait, InvalidPanelName, INTERACTIVE_PROMPT_RE,
} from "../src/amux.ts";

describe("stripAnsi", () => {
  test("removes color codes", () => {
    assert.equal(stripAnsi("\x1b[31mhello\x1b[0m"), "hello");
  });

  test("removes cursor sequences", () => {
    assert.equal(stripAnsi("\x1b[?25habc\x1b[?25l"), "abc");
  });

  test("passes through plain text", () => {
    assert.equal(stripAnsi("no escapes here"), "no escapes here");
  });

  test("removes multiple sequences", () => {
    assert.equal(
      stripAnsi("\x1b[1mone\x1b[0m \x1b[32mtwo\x1b[0m \x1b[4mthree\x1b[0m"),
      "one two three"
    );
  });

  test("empty string", () => {
    assert.equal(stripAnsi(""), "");
  });
});

describe("normalizeKey", () => {
  test("C-c", () => assert.equal(normalizeKey("C-c"), "C-c"));
  test("C-D → C-d", () => assert.equal(normalizeKey("C-D"), "C-d"));
  test("Enter", () => assert.equal(normalizeKey("Enter"), "Enter"));
  test("Tab", () => assert.equal(normalizeKey("Tab"), "Tab"));
  test("Esc → Escape", () => assert.equal(normalizeKey("Esc"), "Escape"));
  test("BSpace", () => assert.equal(normalizeKey("BSpace"), "BSpace"));
  test("Space", () => assert.equal(normalizeKey("Space"), "Space"));
  test("arrows", () => {
    assert.equal(normalizeKey("Up"), "Up");
    assert.equal(normalizeKey("Down"), "Down");
    assert.equal(normalizeKey("Left"), "Left");
    assert.equal(normalizeKey("Right"), "Right");
  });
  test("literal text returns undefined", () => {
    assert.equal(normalizeKey("hello world"), undefined);
  });
  test("C-z", () => assert.equal(normalizeKey("C-z"), "C-z"));
});

describe("INTERACTIVE_PROMPT_RE", () => {
  test("matches password prompts", () => {
    assert.equal(INTERACTIVE_PROMPT_RE.test("Password: "), true);
    assert.equal(INTERACTIVE_PROMPT_RE.test("Enter password: "), true);
    assert.equal(INTERACTIVE_PROMPT_RE.test("Passphrase: "), true);
  });

  test("matches y/n prompts", () => {
    assert.equal(INTERACTIVE_PROMPT_RE.test("Continue? [y/n] "), true);
    assert.equal(INTERACTIVE_PROMPT_RE.test("Proceed? [yes/no] "), true);
    assert.equal(INTERACTIVE_PROMPT_RE.test("Overwrite? (y/n) "), true);
  });

  test("matches press enter", () => {
    assert.equal(INTERACTIVE_PROMPT_RE.test("Press Enter to continue"), true);
    assert.equal(INTERACTIVE_PROMPT_RE.test("Press any key"), true);
  });

  test("does not match normal output", () => {
    assert.equal(INTERACTIVE_PROMPT_RE.test("Compiling main.rs..."), false);
    assert.equal(INTERACTIVE_PROMPT_RE.test("server listening on port 3000"), false);
    assert.equal(INTERACTIVE_PROMPT_RE.test("3 tests passed"), false);
  });
});

describe("validatePanelName", () => {
  test("rejects empty", () => {
    assert.throws(() => validatePanelName(""), (e: any) => e instanceof InvalidPanelName);
  });

  test("rejects null/undefined", () => {
    assert.throws(() => validatePanelName(null), (e: any) => e instanceof InvalidPanelName);
    assert.throws(() => validatePanelName(undefined), (e: any) => e instanceof InvalidPanelName);
  });

  test("rejects spaces", () => {
    assert.throws(() => validatePanelName("my app"), (e: any) => e instanceof InvalidPanelName);
  });

  test("rejects colons", () => {
    assert.throws(() => validatePanelName("host:port"), (e: any) => e instanceof InvalidPanelName);
  });

  test("rejects dots", () => {
    assert.throws(() => validatePanelName("v1.2"), (e: any) => e instanceof InvalidPanelName);
  });

  test("rejects slashes", () => {
    assert.throws(() => validatePanelName("path/to"), (e: any) => e instanceof InvalidPanelName);
  });

  test("rejects reserved init panel", () => {
    assert.throws(() => validatePanelName(config.initPanel), (e: any) => e instanceof InvalidPanelName);
  });

  test("allows alphanumeric, dash, underscore", () => {
    assert.doesNotThrow(() => validatePanelName("my-app_v2"));
  });
});

describe("socketPath", () => {
  test("uses /tmp and uid", () => {
    const orig = config.socketName;
    config.socketName = "test-socket";
    assert.equal(socketPath(), `/tmp/tmux-${process.getuid!()}/test-socket`);
    config.socketName = orig;
  });

  test("respects TMUX_TMPDIR", () => {
    const origSocket = config.socketName;
    const origEnv = process.env.TMUX_TMPDIR;
    config.socketName = "test-socket";
    process.env.TMUX_TMPDIR = "/custom/tmp";
    assert.equal(socketPath(), `/custom/tmp/tmux-${process.getuid!()}/test-socket`);
    config.socketName = origSocket;
    if (origEnv === undefined) delete process.env.TMUX_TMPDIR;
    else process.env.TMUX_TMPDIR = origEnv;
  });
});

describe("detectInputWait", () => {
  test("detects amux prompt (success)", () => {
    assert.equal(detectInputWait("server ~/myapp $ ", "server"), "prompt");
  });

  test("detects amux prompt (failure)", () => {
    assert.equal(detectInputWait("server [exit 1] ~/myapp $ ", "server"), "prompt");
  });

  test("detects amux prompt with deep path", () => {
    assert.equal(detectInputWait("api ~/src/projects/api $ ", "api"), "prompt");
  });

  test("detects password prompt", () => {
    assert.equal(detectInputWait("Enter password: ", "server"), "interactive");
  });

  test("detects y/n prompt", () => {
    assert.equal(detectInputWait("Overwrite file? [y/n]: ", "server"), "interactive");
  });

  test("detects yes/no prompt", () => {
    assert.equal(detectInputWait("Proceed? [yes/no] ", "server"), "interactive");
  });

  test("detects press enter", () => {
    assert.equal(detectInputWait("Press Enter to continue", "server"), "interactive");
  });

  test("returns false for normal output", () => {
    assert.equal(detectInputWait("Compiling main.rs...", "server"), false);
    assert.equal(detectInputWait("GET / 200 4ms", "server"), false);
    assert.equal(detectInputWait("", "server"), false);
  });

  test("does not false-match different panel name", () => {
    assert.equal(detectInputWait("other ~/path $ ", "server"), false);
  });
});
