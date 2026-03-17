#!/bin/bash
# Stress: progress bars, timing output, colored benchmarks
# Tests: \r carriage returns for progress, mixed ANSI
hyperfine --warmup 1 --runs 5 'echo hello' 'printf world' 2>&1
