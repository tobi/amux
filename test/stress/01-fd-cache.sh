#!/bin/bash
# Stress: fast burst of file paths with colors
# Tests: high-throughput output, ANSI color codes, large volume
fd --color=always -t f . ~/.cache 2>/dev/null | head -200
