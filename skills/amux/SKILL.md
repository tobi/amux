---
name: amux
description: Run background tasks, long-running processes, servers, and anything you'd use tmux for. Named panels persist across commands. Use for dev servers, Electron apps, build watchers, tailing logs, running test suites, or any process that needs to keep running while you do other work.
---

# amux — background panels for agents

`amux` manages named tmux panels for long-running processes. Panels are created automatically on first use, persist across commands, and their names never drift.

Each panel runs a minimal bash shell with a prompt showing the panel name and exit codes:
```
server ~/myapp $              # success
server [exit 1] ~/myapp $    # failure with exit code
```

## Tools

Use the amux tools — do NOT shell out to `amux` via bash.

### amux_shell

Run a command in a named panel. Creates the panel if it doesn't exist. Streams output back until the prompt returns or timeout is hit.

```
amux_shell(name: "server", command: "npm start")
amux_shell(name: "server", command: "npm start", timeout: 10)
```

Panel names should be short and descriptive: `server`, `build`, `test`, `worker`, `repl`.

Reusing a panel name runs the new command in the same panel — history and state are preserved.

### amux_send_keys

Send raw keystrokes to a panel. Each element is a separate key. Does NOT automatically append Enter.

```
amux_send_keys(name: "repl", keys: ["puts :hello", "Enter"])
amux_send_keys(name: "server", keys: ["C-c"])
```

**Key reference:**

| Keys | Examples |
|------|----------|
| Ctrl combos | `C-c` `C-d` `C-z` `C-l` `C-a` `C-e` |
| Special | `Enter` `Tab` `Esc` `Space` `BSpace` |
| Arrows | `Up` `Down` `Left` `Right` |
| Literal text | `"hello world"` (sent as typed, no Enter) |

### amux_read

Capture the current visible panel buffer. Use `full: true` for complete scrollback.

```
amux_read(name: "server")
amux_read(name: "server", full: true)
```

### amux_kill

Remove a single panel.

```
amux_kill(name: "server")
```

### amux_list

List all active panels.

```
amux_list()
```

## Typical Workflows

### Dev server + health check

```
amux_shell(name: "server", command: "npm start")
# wait, then check
amux_read(name: "server")
amux_shell(name: "server", command: "curl -s localhost:3000/health")
```

### Parallel processes

```
amux_shell(name: "api", command: "npm run api")
amux_shell(name: "web", command: "npm run web")
amux_shell(name: "worker", command: "npm run worker")
amux_list()
```

### Interactive REPL

```
amux_shell(name: "repl", command: "python3")
amux_send_keys(name: "repl", keys: ["import json", "Enter"])
amux_send_keys(name: "repl", keys: ["print(json.dumps({'a': 1}))", "Enter"])
amux_read(name: "repl")
amux_send_keys(name: "repl", keys: ["C-d"])
```

### Build and watch logs

```
amux_shell(name: "build", command: "make -j8 2>&1 | tee build.log")
# later...
amux_read(name: "build")
amux_read(name: "build", full: true)
```

### Interrupt and restart

```
amux_send_keys(name: "server", keys: ["C-c"])
amux_shell(name: "server", command: "npm start -- --port 4000")
```

### Clean up

```
amux_kill(name: "server")           # just one panel
```

## Key Behaviors

- **Auto-creation**: `amux_shell` and `amux_send_keys` create panels on first use. No setup step.
- **Persistence**: Panels survive across tool calls. They live in tmux.
- **Timeout**: Default 5 seconds. When a command times out, the output tells you the panel is still running and to use `amux_read` to check later.
- **Deterministic names**: Panel titles are locked. Shell escape sequences cannot rename them.
- **Isolated tmux**: amux uses its own tmux socket and config. It never conflicts with personal tmux.
- **Clean output**: No ANSI color codes in streamed output — clean text only.
