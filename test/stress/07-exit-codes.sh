#!/bin/bash
# Stress: non-zero exit code
# Tests: FAIL EXITCODE detection
echo "about to fail..."
echo "some output first"
echo "and more"
exit 42
