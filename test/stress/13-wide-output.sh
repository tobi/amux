#!/bin/bash
# Stress: very wide lines (300+ chars)
# Tests: line truncation, horizontal overflow handling
for i in $(seq 1 10); do
  printf "LINE %02d: " "$i"
  python3 -c "print('ABCDEFGHIJ' * 30)"
done
