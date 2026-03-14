import { describe, test, expect } from "bun:test";
import {
  stripAnsi, normalizeKey, validatePanelName, socketPath, config,
  detectInputWait, InvalidPanelName, INTERACTIVE_PROMPT_RE,
} from "../src/amux.ts";

describe("stripAnsi", () => {
  test("removes color codes", () => {
    expect(stripAnsi("\x1b[31mhello\x1b[0m")).toBe("hello");
  });

  test("removes cursor sequences", () => {
    expect(stripAnsi("\x1b[?25habc\x1b[?25l")).toBe("abc");
  });

  test("passes through plain text", () => {
    expect(stripAnsi("no escapes here")).toBe("no escapes here");
  });

  test("removes multiple sequences", () => {
    expect(
      stripAnsi("\x1b[1mone\x1b[0m \x1b[32mtwo\x1b[0m \x1b[4mthree\x1b[0m")
    ).toBe("one two three");
  });

  test("empty string", () => {
    expect(stripAnsi("")).toBe("");
  });
});

describe("normalizeKey", () => {
  test("C-c", () => expect(normalizeKey("C-c")).toBe("C-c"));
  test("C-D → C-d", () => expect(normalizeKey("C-D")).toBe("C-d"));
  test("Enter", () => expect(normalizeKey("Enter")).toBe("Enter"));
  test("Tab", () => expect(normalizeKey("Tab")).toBe("Tab"));
  test("Esc → Escape", () => expect(normalizeKey("Esc")).toBe("Escape"));
  test("BSpace", () => expect(normalizeKey("BSpace")).toBe("BSpace"));
  test("Space", () => expect(normalizeKey("Space")).toBe("Space"));
  test("arrows", () => {
    expect(normalizeKey("Up")).toBe("Up");
    expect(normalizeKey("Down")).toBe("Down");
    expect(normalizeKey("Left")).toBe("Left");
    expect(normalizeKey("Right")).toBe("Right");
  });
  test("literal text returns undefined", () => {
    expect(normalizeKey("hello world")).toBeUndefined();
  });
  test("C-z", () => expect(normalizeKey("C-z")).toBe("C-z"));
});

describe("INTERACTIVE_PROMPT_RE", () => {
  test("matches password prompts", () => {
    expect(INTERACTIVE_PROMPT_RE.test("Password: ")).toBe(true);
    expect(INTERACTIVE_PROMPT_RE.test("Enter password: ")).toBe(true);
    expect(INTERACTIVE_PROMPT_RE.test("Passphrase: ")).toBe(true);
  });

  test("matches y/n prompts", () => {
    expect(INTERACTIVE_PROMPT_RE.test("Continue? [y/n] ")).toBe(true);
    expect(INTERACTIVE_PROMPT_RE.test("Proceed? [yes/no] ")).toBe(true);
    expect(INTERACTIVE_PROMPT_RE.test("Overwrite? (y/n) ")).toBe(true);
  });

  test("matches press enter", () => {
    expect(INTERACTIVE_PROMPT_RE.test("Press Enter to continue")).toBe(true);
    expect(INTERACTIVE_PROMPT_RE.test("Press any key")).toBe(true);
  });

  test("does not match normal output", () => {
    expect(INTERACTIVE_PROMPT_RE.test("Compiling main.rs...")).toBe(false);
    expect(INTERACTIVE_PROMPT_RE.test("server listening on port 3000")).toBe(false);
    expect(INTERACTIVE_PROMPT_RE.test("3 tests passed")).toBe(false);
  });
});

describe("validatePanelName", () => {
  test("rejects empty", () => {
    expect(() => validatePanelName("")).toThrow(InvalidPanelName);
  });

  test("rejects null/undefined", () => {
    expect(() => validatePanelName(null)).toThrow(InvalidPanelName);
    expect(() => validatePanelName(undefined)).toThrow(InvalidPanelName);
  });

  test("rejects spaces", () => {
    expect(() => validatePanelName("my app")).toThrow(InvalidPanelName);
  });

  test("rejects colons", () => {
    expect(() => validatePanelName("host:port")).toThrow(InvalidPanelName);
  });

  test("rejects dots", () => {
    expect(() => validatePanelName("v1.2")).toThrow(InvalidPanelName);
  });

  test("rejects slashes", () => {
    expect(() => validatePanelName("path/to")).toThrow(InvalidPanelName);
  });

  test("rejects reserved init panel", () => {
    expect(() => validatePanelName(config.initPanel)).toThrow(InvalidPanelName);
  });

  test("allows alphanumeric, dash, underscore", () => {
    expect(() => validatePanelName("my-app_v2")).not.toThrow();
  });
});

describe("socketPath", () => {
  test("uses /tmp and uid", () => {
    const orig = config.socketName;
    config.socketName = "test-socket";
    expect(socketPath()).toBe(`/tmp/tmux-${process.getuid!()}/test-socket`);
    config.socketName = orig;
  });

  test("respects TMUX_TMPDIR", () => {
    const origSocket = config.socketName;
    const origEnv = process.env.TMUX_TMPDIR;
    config.socketName = "test-socket";
    process.env.TMUX_TMPDIR = "/custom/tmp";
    expect(socketPath()).toBe(`/custom/tmp/tmux-${process.getuid!()}/test-socket`);
    config.socketName = origSocket;
    if (origEnv === undefined) delete process.env.TMUX_TMPDIR;
    else process.env.TMUX_TMPDIR = origEnv;
  });
});

describe("detectInputWait", () => {
  test("detects amux prompt (success)", () => {
    expect(detectInputWait("server ~/myapp $ ", "server")).toBe("prompt");
  });

  test("detects amux prompt (failure)", () => {
    expect(detectInputWait("server [exit 1] ~/myapp $ ", "server")).toBe("prompt");
  });

  test("detects amux prompt with deep path", () => {
    expect(detectInputWait("api ~/src/projects/api $ ", "api")).toBe("prompt");
  });

  test("detects password prompt", () => {
    expect(detectInputWait("Enter password: ", "server")).toBe("interactive");
  });

  test("detects y/n prompt", () => {
    expect(detectInputWait("Overwrite file? [y/n]: ", "server")).toBe("interactive");
  });

  test("detects yes/no prompt", () => {
    expect(detectInputWait("Proceed? [yes/no] ", "server")).toBe("interactive");
  });

  test("detects press enter", () => {
    expect(detectInputWait("Press Enter to continue", "server")).toBe("interactive");
  });

  test("returns false for normal output", () => {
    expect(detectInputWait("Compiling main.rs...", "server")).toBe(false);
    expect(detectInputWait("GET / 200 4ms", "server")).toBe(false);
    expect(detectInputWait("", "server")).toBe(false);
  });

  test("does not false-match different panel name", () => {
    expect(detectInputWait("other ~/path $ ", "server")).toBe(false);
  });
});
