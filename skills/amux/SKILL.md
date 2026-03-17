---
name: amux
description: Run background tasks, long-running processes, servers, and anything you'd use tmux for. Named panels persist across commands. Use for dev servers, Electron apps, build watchers, tailing logs, running test suites, or any process that needs to keep running while you do other work.
---

# amux — background panels for agents

Named tmux panels for long-running processes. Panels are created on first use, tiled within tabs grouped by cwd.

Prompt: `name $ ` (success) or `name [exit N] $ ` (failure)

## The run → tail workflow

This is the primary pattern. Start with `amux_shell`, which streams output for a short timeout (default 5s). If it finishes, you get SUCCESS or FAIL. If it times out, the output tells you exactly how to continue:

```
⏳ timeout 5s — continue with:
  amux_tail(name: "tests", follow: true, offset: 4820)
```

Call `amux_tail` with that offset to resume exactly where `amux_shell` stopped. No output is lost or duplicated. If `amux_tail` also times out, it prints another continuation hint — keep chaining until done.

### Quick command (finishes in time)
```
amux_shell(name: "test", command: "npm test")
→ ... test output ...
→ SUCCESS
```

### Long command (timeout → continue)
```
amux_shell(name: "test", command: "npm test")
→ ... partial output ...
→ ⏳ timeout 5s — continue with:
→   amux_tail(name: "test", follow: true, offset: 4820)

amux_tail(name: "test", follow: true, offset: 4820)
→ ... remaining output ...
→ SUCCESS
```

### Very long command (chain multiple tails)
```
amux_shell(name: "build", command: "make all", timeout: 30)
→ ⏳ timeout 30s — continue with:
→   amux_tail(name: "build", follow: true, offset: 52000)

amux_tail(name: "build", follow: true, offset: 52000, timeout: 120)
→ ⏳ timeout 120s — continue with:
→   amux_tail(name: "build", follow: true, offset: 128400)

amux_tail(name: "build", follow: true, offset: 128400, timeout: 120)
→ ... final output ...
→ SUCCESS
```

## Tools

### amux_shell

Run a command in a panel. Streams output from start. Default timeout 5s, max 300s.

```
amux_shell(name: "server", command: "npm start")
amux_shell(name: "server", command: "npm start", timeout: 30)
```

### amux_tail

Tail panel output. Default: last 10 lines. Use `follow: true` to stream live. Use `offset` to continue from a previous timeout.

```
amux_tail(name: "server")                                          # last 10 lines
amux_tail(name: "server", lines: 50)                               # last 50 lines
amux_tail(name: "server", follow: true)                            # follow until done (60s)
amux_tail(name: "server", follow: true, offset: 4820)             # continue from offset
amux_tail(name: "server", follow: true, offset: 4820, timeout: 120)  # custom timeout
```

### amux_send_keys

Send keystrokes. Does NOT auto-append Enter.

```
amux_send_keys(name: "repl", keys: ["puts :hello", "Enter"])
amux_send_keys(name: "server", keys: ["C-c"])
```

Keys: `C-c` `C-d` `C-z` `Enter` `Tab` `Esc` `Space` `BSpace` `Up` `Down` `Left` `Right`

### amux_kill

```
amux_kill(name: "server")
```

### amux_list

```
amux_list()
```

## Key Behaviors

- **Auto-creation**: panels created on first use. No setup.
- **Tiled layout**: panels from same cwd share a tmux tab.
- **Timeout cap**: all timeouts max 300s (5 minutes).
- **Completion signals**: `SUCCESS` or `FAIL EXITCODE:N` printed on own line.
- **Byte offsets**: timeout messages include exact byte offset for seamless continuation.
- **Isolated tmux**: own socket and config. Never conflicts with personal tmux.
