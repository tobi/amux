import { describe, test } from "node:test";
import { strict as assert } from "node:assert";
import {
  stripAnsi, normalizeKey, validatePanelName, socketPath, config, clampTimeout,
  detectEnd, detectInputWait, InvalidPanelName, AmuxError, INTERACTIVE_PROMPT_RE,
  SUCCESS_RE, FAIL_RE, MAX_TIMEOUT, rejectNesting,
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

describe("SUCCESS_RE / FAIL_RE", () => {
  test("SUCCESS matches", () => {
    assert.ok(SUCCESS_RE.test("SUCCESS"));
  });

  test("FAIL matches with exit code", () => {
    const m = FAIL_RE.exec("FAIL EXITCODE:127");
    assert.ok(m);
    assert.equal(m![1], "127");
  });

  test("FAIL matches exit code 1", () => {
    const m = FAIL_RE.exec("FAIL EXITCODE:1");
    assert.ok(m);
    assert.equal(m![1], "1");
  });

  test("does not match embedded", () => {
    assert.equal(SUCCESS_RE.test("foo SUCCESS bar"), false);
    assert.equal(FAIL_RE.test("foo FAIL EXITCODE:1 bar"), false);
  });

  test("does not match empty", () => {
    assert.equal(SUCCESS_RE.test(""), false);
    assert.equal(FAIL_RE.test(""), false);
  });
});

describe("detectEnd", () => {
  test("detects SUCCESS", () => {
    const r = detectEnd("SUCCESS", "server");
    assert.deepEqual(r, { type: "success", exitCode: 0 });
  });

  test("detects FAIL", () => {
    const r = detectEnd("FAIL EXITCODE:127", "server");
    assert.deepEqual(r, { type: "fail", exitCode: 127 });
  });

  test("detects prompt (success)", () => {
    const r = detectEnd("server $", "server");
    assert.ok(r);
    assert.equal(r && r.type, "prompt");
  });

  test("detects prompt (failure)", () => {
    const r = detectEnd("server [exit 1] $", "server");
    assert.ok(r);
    assert.equal(r && r.type, "prompt");
  });

  test("detects interactive prompt", () => {
    const r = detectEnd("Enter password: ", "server");
    assert.ok(r);
    assert.equal(r && r.type, "interactive");
  });

  test("returns false for normal output", () => {
    assert.equal(detectEnd("Compiling main.rs...", "server"), false);
    assert.equal(detectEnd("GET / 200 4ms", "server"), false);
    assert.equal(detectEnd("", "server"), false);
  });

  test("does not false-match different panel name", () => {
    assert.equal(detectEnd("other $ ", "server"), false);
  });
});

describe("detectInputWait (backward compat)", () => {
  test("maps SUCCESS to prompt", () => {
    assert.equal(detectInputWait("SUCCESS", "server"), "prompt");
  });

  test("maps FAIL to prompt", () => {
    assert.equal(detectInputWait("FAIL EXITCODE:1", "server"), "prompt");
  });

  test("maps interactive", () => {
    assert.equal(detectInputWait("Enter password: ", "server"), "interactive");
  });

  test("returns false for normal", () => {
    assert.equal(detectInputWait("hello world", "server"), false);
  });
});

describe("clampTimeout", () => {
  test("passes through normal values", () => {
    assert.equal(clampTimeout(5), 5);
    assert.equal(clampTimeout(60), 60);
  });

  test("caps at MAX_TIMEOUT", () => {
    assert.equal(clampTimeout(999), MAX_TIMEOUT);
    assert.equal(clampTimeout(MAX_TIMEOUT), MAX_TIMEOUT);
  });

  test("floors at 0", () => {
    assert.equal(clampTimeout(-1), 0);
  });
});

describe("rejectNesting", () => {
  test("rejects amux commands", () => {
    assert.throws(() => rejectNesting("amux server run ls"), (e: any) => e instanceof AmuxError);
  });

  test("rejects tmux commands", () => {
    assert.throws(() => rejectNesting("tmux new-session"), (e: any) => e instanceof AmuxError);
  });

  test("rejects zellij commands", () => {
    assert.throws(() => rejectNesting("zellij attach"), (e: any) => e instanceof AmuxError);
  });

  test("rejects case-insensitive", () => {
    assert.throws(() => rejectNesting("TMUX list-sessions"), (e: any) => e instanceof AmuxError);
  });

  test("allows normal commands", () => {
    assert.doesNotThrow(() => rejectNesting("npm test"));
    assert.doesNotThrow(() => rejectNesting("echo hello"));
    assert.doesNotThrow(() => rejectNesting("ls -la"));
  });
});
