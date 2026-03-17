#!/bin/bash
# Stress: colored grep output with filenames, line numbers, match highlights
# Tests: multi-color ANSI (filename=magenta, lineno=green, match=red)
rg --color=always -n 'function|async|export' /Users/tobi/src/tries/2026-03-14-ag/src/amux.ts | head -80
