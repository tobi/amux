#!/bin/bash
# Stress: 256-color output
# Tests: extended ANSI color sequences survive (not stripped)
for i in $(seq 0 15); do
  for j in $(seq 0 15); do
    c=$((i * 16 + j))
    printf "\e[48;5;%dm %3d " "$c" "$c"
  done
  printf "\e[0m\n"
done
echo ""
echo "Done — 256 colors rendered."
