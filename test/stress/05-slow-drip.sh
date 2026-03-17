#!/bin/bash
# Stress: very slow output — one line every 2 seconds
# Tests: long gaps between output, timeout behavior
for i in $(seq 1 10); do
  echo "$(date +%H:%M:%S) tick $i"
  sleep 2
done
