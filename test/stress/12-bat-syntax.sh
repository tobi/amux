#!/bin/bash
# Stress: syntax-highlighted source code
# Tests: complex ANSI (256-color syntax), line numbers, decorations
bat --color=always --paging=never --style=numbers,grid /Users/tobi/src/tries/2026-03-14-ag/src/amux.ts 2>&1 | head -50
