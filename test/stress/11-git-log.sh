#!/bin/bash
# Stress: git log with graph and colors
# Tests: complex ANSI (bold, color, graph chars), unicode
cd /Users/tobi/src/tries/2026-03-14-ag
git log --oneline --graph --color=always --decorate -30
