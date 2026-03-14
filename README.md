# amux — agentic mux

Named tmux panels for AI agents and humans. Panels are created on first use, scoped to your working directory, and persistent across commands. Think `tmux` but you never manage sessions — just name things and go.

```
amux server shell "npm start"     # start a dev server
amux server read                  # check its output
amux server send-keys C-c         # interrupt it
amux watch                        # see everything live
```

## Why

AI agents need to run background processes — dev servers, build watchers, test suites, REPLs — and check on them later. `amux` gives agents (and humans) a dead-simple interface: named panels that stay alive.

Output streaming uses [`@xterm/headless`](https://www.npmjs.com/package/@xterm/headless) to parse terminal state. Raw escape sequences go in, clean text comes out. No ANSI regex. The virtual terminal handles cursor movement, line clearing, and redraws the same way a real terminal would.

## Install

As a CLI tool:

```bash
bun install -g https://github.com/tobi/amux
```

As a [pi](https://github.com/mariozechner/pi) package (adds tools + skill to the agent):

```bash
pi install https://github.com/tobi/amux
```

Requires [tmux](https://github.com/tmux/tmux) and [Bun](https://bun.sh).

## CLI

### For humans

```bash
amux watch              # see all panels live (starts in watch mode)
amux watch -r           # attach read-only
amux list               # show active panels
amux terminate --yes    # shut down everything
```

Inside `amux watch`:

| Key | Action |
|-----|--------|
| `M-1`..`M-9` | Switch between panels |
| `Esc` | Enter scroll/watch mode |
| `Enter` | Drop into edit mode (type into the panel) |
| `M-q` | Detach |
| `M-t` | Terminate all panels |

The status bar is context-sensitive — it shows different hints depending on whether you're watching or editing.

### For agents

```bash
amux NAME shell CMD       # run command, stream output back
amux NAME send-keys K...  # send keystrokes
amux NAME read            # capture current screen
amux NAME read --full     # capture full scrollback
amux NAME kill            # remove a panel
```

**Timeout flag:** `-tN` sets the streaming timeout in seconds (default: 5). When a command times out, amux tells you how to keep watching:

```
$ amux server shell "npm start" -t3
listening on :3000
...
timeout 3s: still running. Use `amux server read` to check output.
```

**send-keys reference:**

| Key | Description |
|-----|-------------|
| `C-c` `C-d` `C-z` | Ctrl combos |
| `Enter` `Tab` `Esc` `Space` | Special keys |
| `Up` `Down` `Left` `Right` | Arrow keys |
| `BSpace` | Backspace |
| `"some text"` | Literal text (no Enter added) |

## Library

```typescript
import { shell, read, sendKeys, kill, list, panels } from "amux";

// Run a command, stream output for 5s
const timedOut = shell("server", "npm start", { timeout: 5 });

// Read the screen
const output = read("server");
const fullOutput = read("server", { full: true });

// Send keystrokes
sendKeys("repl", ["puts :hi", "Enter"], { timeout: 3 });

// Ctrl-C
sendKeys("server", ["C-c"]);

// Clean up
kill("server");
```

All functions are synchronous. `shell` and `sendKeys` return `true` if they timed out (the process is still running).

## pi extension

amux ships as a [pi](https://github.com/mariozechner/pi) extension. Install the package and pi auto-discovers the extension via `package.json`:

```json
{
  "pi": {
    "extensions": ["./ext/index.ts"]
  }
}
```

The extension provides five tools to the LLM:

| Tool | Description |
|------|-------------|
| `amux_shell` | Run a command in a named panel |
| `amux_read` | Read a panel's screen buffer |
| `amux_send_keys` | Send keystrokes to a panel |
| `amux_kill` | Remove a panel |
| `amux_list` | List all panels |

It also adds a **status bar indicator** showing recently active panels (active = any interaction within the last 3 minutes). Panel activity state is persisted in `~/.amux/cache/`.

Use `/amux` in pi to check panel status.

## How it works

All panels live as windows inside a single tmux session. One tmux server, one session, many windows — each window is a named panel.

```
tmux server (socket: amux)
  └── session: amux
        ├── window 1: server     ← amux server shell "npm start"
        ├── window 2: build      ← amux build shell "npm run watch"
        └── window 3: test       ← amux test shell "bun test --watch"
```

**Panel creation is lazy.** First time you reference a name, amux creates the session (if needed) and the window. The init window gets renamed on first use, subsequent panels get new windows.

**Output streaming** works by having tmux `pipe-pane` write raw output to a temp file. amux polls that file, feeds bytes into an `@xterm/headless` virtual terminal, then reads clean screen text from the terminal buffer. This handles all escape sequences correctly — cursor movement, line clearing, color codes, alternate screen buffers — without any regex.

**Prompt detection** checks the virtual terminal's cursor line against known patterns (the amux bash prompt, password prompts, y/n confirmations) to stop streaming early when the command is done.

Each panel runs a minimal bash shell with a prompt that shows the panel name, exit codes, and working directory:

```
server ~/myapp $              # success
server [exit 1] ~/myapp $    # last command failed
```

## Configuration

amux uses its own tmux config (`conf/amux/tmux.conf`) and bash profile (`conf/amux/bashrc`). Titles are locked down — shell escape sequences can't rename panels. All keybindings use Meta (Alt) since Ctrl+digit doesn't work reliably across terminals.

Logs go to `~/.amux/logs/`. When streaming times out, the raw terminal bytes are saved there for debugging:

```
amux: raw output saved to ~/.amux/logs/server-stream-20260314-091500-1.raw
amux: inspect with: xxd ~/.amux/logs/server-stream-20260314-091500-1.raw | less
```

## Tests

```bash
bun test                    # all tests
bun test test/unit.test.ts  # unit tests only (fast)
bun test test/integration.test.ts  # integration tests (needs tmux)
```

Integration tests use isolated tmux sockets so they don't interfere with your real amux session.

## License

MIT
