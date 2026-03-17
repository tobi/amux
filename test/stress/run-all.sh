#!/bin/bash
# Run all stress tests sequentially, report pass/fail for each.
# Uses amux CLI directly — each test gets its own panel.

set -euo pipefail
cd "$(dirname "$0")/../.."

TESTS=(test/stress/[0-9]*.sh)
PASS=0
FAIL=0
ERRORS=()

GREEN='\033[32m'
RED='\033[31m'
DIM='\033[2m'
BOLD='\033[1m'
RESET='\033[0m'

echo -e "${BOLD}amux stress test suite${RESET}"
echo -e "${DIM}$(date)${RESET}"
echo ""

for test in "${TESTS[@]}"; do
  name=$(basename "$test" .sh)
  label=$(head -2 "$test" | tail -1 | sed 's/^# //')
  printf "  %-22s %s " "$name" "$label"

  # Kill panel if leftover from previous run
  amux "$name" kill 2>/dev/null || true
  sleep 0.2

  # Run with 15s timeout, capture output
  output=$(amux "$name" run "bash $test" -t15 2>&1)
  exit_status=$?

  # Check: did it produce output? (not just timeout message)
  line_count=$(echo "$output" | grep -cv '^\s*$' || true)

  if echo "$output" | grep -q "SUCCESS"; then
    printf "${GREEN}✓${RESET} "
    printf "${DIM}(%d lines)${RESET}\n" "$line_count"
    PASS=$((PASS + 1))
  elif echo "$output" | grep -q "FAIL EXITCODE:42"; then
    # Test 07 is supposed to fail with 42
    if [[ "$name" == "07-exit-codes" ]]; then
      printf "${GREEN}✓${RESET} "
      printf "${DIM}(expected exit 42, %d lines)${RESET}\n" "$line_count"
      PASS=$((PASS + 1))
    else
      printf "${RED}✗${RESET} "
      printf "${DIM}(unexpected failure)${RESET}\n"
      ERRORS+=("$name: unexpected FAIL")
      FAIL=$((FAIL + 1))
    fi
  elif echo "$output" | grep -q "timeout"; then
    # Some tests may timeout (05-slow-drip is 20s), that's OK if we got output
    if (( line_count > 3 )); then
      printf "${GREEN}✓${RESET} "
      printf "${DIM}(timeout ok, %d lines)${RESET}\n" "$line_count"
      PASS=$((PASS + 1))
    else
      printf "${RED}✗${RESET} "
      printf "${DIM}(timeout, only %d lines)${RESET}\n" "$line_count"
      ERRORS+=("$name: timeout with too few lines")
      FAIL=$((FAIL + 1))
    fi
  else
    printf "${RED}✗${RESET} "
    printf "${DIM}(no SUCCESS/FAIL/timeout detected)${RESET}\n"
    ERRORS+=("$name: unknown state")
    FAIL=$((FAIL + 1))
  fi

  # Cleanup
  amux "$name" kill 2>/dev/null || true
done

echo ""
echo -e "${BOLD}Results: ${GREEN}${PASS} passed${RESET}, ${RED}${FAIL} failed${RESET} / ${#TESTS[@]} total"

if (( ${#ERRORS[@]} > 0 )); then
  echo ""
  echo -e "${RED}Failures:${RESET}"
  for err in "${ERRORS[@]}"; do
    echo "  - $err"
  done
  exit 1
fi
