#!/bin/bash
# Stress: stdout and stderr interleaved, mixed speeds
# Tests: both streams captured, ordering preserved
for i in $(seq 1 20); do
  if (( i % 3 == 0 )); then
    echo "stderr: line $i" >&2
  else
    echo "stdout: line $i"
  fi
  sleep 0.1
done
