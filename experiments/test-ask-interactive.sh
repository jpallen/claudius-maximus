#!/bin/bash
# Test script to see how Claude handles AskUserQuestion interactively (no -p, no CI)

echo "=== Testing Claude AskUserQuestion in interactive mode ==="
echo ""

# Run claude WITHOUT -p flag to see if it's more interactive
# Note: This starts an interactive session
unset CI
claude --output-format stream-json \
  --verbose \
  --model haiku \
  "Ask the user what their favourite colour is using the AskUserQuestion tool. Wait for their response before proceeding."
