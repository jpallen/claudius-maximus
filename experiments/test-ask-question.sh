#!/bin/bash
# Test script to see how Claude handles AskUserQuestion in streaming mode

echo "=== Testing Claude AskUserQuestion in stream-json mode ==="
echo ""

# Run claude with a prompt that should trigger AskUserQuestion
claude -p "Ask the user what their favourite colour is using the AskUserQuestion tool. Wait for their response before proceeding." \
  --output-format stream-json \
  --verbose \
  --model haiku

echo ""
echo "=== Done ==="
