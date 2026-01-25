#!/bin/bash
# Test with regular json output (not streaming)

echo "=== Testing Claude AskUserQuestion with json output ==="
echo ""

claude -p "Ask the user what their favourite colour is using the AskUserQuestion tool. Wait for their response before proceeding." \
  --output-format json \
  --model haiku

echo ""
echo "=== Done ==="
