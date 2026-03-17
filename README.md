# amux — agentic mux

Named tmux panels for AI agents and humans. Panels are created automatically on first use, tiled within tabs grouped by working directory.

## Install

```bash
npm install -g https://github.com/tobi/amux
```

## The run → tail workflow

This is the primary way amux is used. The agent starts a command with `run`, which streams output for a short timeout (default 5s). If the command finishes in time, you get `SUCCESS` or `FAIL EXITCODE:N`. If it times out, the output includes a **continuation hint** with the byte offset where output stopped — the agent then calls `tail` with that offset to pick up exactly where it left off.

### Example: fast command (completes within timeout)

```
$ amux server run "echo hello"
echo hello
hello

SUCCESS
```

### Example: slow command (timeout → continue with tail)

```
$ amux tests run "npm test" -t10
npm test

> test
> jest --runInBand

PASS src/utils.test.ts
PASS src/api.test.ts

⏳ timeout 10s — continue with:
  amux_tail(name: "tests", follow: true, offset: 4820)
```

The agent sees the timeout and uses the printed hint to resume:

```
$ amux tests tail -f -c 4820
PASS src/models.test.ts
PASS src/routes.test.ts

Tests: 47 passed
Time: 23.4s

SUCCESS
```

No output is lost. No output is duplicated. The byte offset is the exact position in the log file where `run` stopped reading.

### Example: chained timeouts

If `tail` also times out (very long-running process), it prints another continuation hint:

```
$ amux build tail -f -c 4820 -t60
... 60 seconds of output ...

⏳ timeout 60s — continue with:
  amux_tail(name: "build", follow: true, offset: 128400)
```

The agent can keep chaining `tail` calls until the command completes.

## Commands

### `amux NAME run CMD`

Run a command in a panel. Creates the panel if it doesn't exist. Streams all output from the start of the command.

- Default timeout: **5 seconds** (`-t5`)
- Max timeout: 300 seconds (5 minutes)
- Prints `SUCCESS` or `FAIL EXITCODE:N` on completion
- Prints continuation hint with byte offset on timeout

```bash
amux server run "npm start"           # 5s default
amux server run "npm test" -t30       # 30s timeout
```

### `amux NAME tail`

Tail the panel log. Without `--follow`, prints the last N lines and exits.

- Default lines: **10** (`--lines=10`)
- Default timeout: **60 seconds** (`-t60`)
- `-c OFFSET`: start from byte offset (for continuation after run/tail timeout)
- `--follow` / `-f`: keep tailing until command completes or timeout

```bash
amux server tail                      # last 10 lines
amux server tail --lines=50           # last 50 lines  
amux server tail -f                   # follow until done or 60s
amux server tail -f -c 4820          # continue from offset
amux server tail -f -c 4820 -t120   # continue with 2min timeout
```

### `amux NAME panel-get`

Dump the raw tmux panel screen content (what you'd see if you looked at the terminal).

```bash
amux server panel-get                 # visible screen
amux server panel-get --full          # full scrollback
```

### `amux NAME send-keys K...`

Send keystrokes to a panel. Each argument is a separate key.

```bash
amux server send-keys C-c            # Ctrl-C
amux repl send-keys "puts :hi" Enter # type + enter
```

Key reference: `C-c` `C-d` `C-z` `Enter` `Tab` `Esc` `Space` `BSpace` `Up` `Down` `Left` `Right`

### `amux NAME kill`

Remove a panel.

### `amux list`

List all active panels, grouped by tab.

### `amux watch`

Open tmux to see all tabs and panels live. Tabs are cwd directories, panels are tiled panes within each tab.

- `M-1` through `M-9`: switch tabs
- `Esc`: scroll mode
- `M-q`: detach
- `M-t`: terminate all

### `amux terminate --yes`

Destroy all panels and the tmux session.

## Architecture

- **One tmux session** (`amux`) with its own socket — never conflicts with personal tmux
- **Tabs** (tmux windows) are named after the working directory basename
- **Panels** (tmux panes) are tiled within tabs, each running a minimal bash shell
- **Logs** are written to `~/.amux/panels/{name}.log` via tmux pipe-pane
- **Sidecar files** track pane→name mapping since tmux doesn't expose pane env vars
- **Sentinels**: bash PROMPT_COMMAND prints `SUCCESS` or `FAIL EXITCODE:N` on its own line after each command
- **Prompt**: `name $ ` (no path, minimal, deterministic)
- **Timeout cap**: all timeouts capped at 300 seconds (5 minutes)

## pi extension

amux ships as a [pi](https://github.com/mariozechner/pi) package with tools:

- `amux_shell` — wraps `run` with async completion detection
- `amux_tail` — wraps `tail` with offset support for continuation
- `amux_send_keys` — send keystrokes
- `amux_kill` — remove a panel
- `amux_list` — list panels

The extension also provides a tab bar widget with `⌥1-9` hotkeys for panel trailing.
