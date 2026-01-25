#!/bin/bash
# Test script to explore resuming a session with an answer

echo "=== Step 1: Run Claude to get a question, capture session ID ==="

# Run and capture output
OUTPUT=$(claude -p "Ask the user what their favourite colour is using the AskUserQuestion tool." \
  --output-format stream-json \
  --verbose \
  --model haiku 2>&1)

echo "$OUTPUT" | head -5
echo "..."

# Extract session ID from output
SESSION_ID=$(echo "$OUTPUT" | grep -o '"session_id":"[^"]*"' | head -1 | sed 's/"session_id":"//;s/"//')

echo ""
echo "=== Session ID: $SESSION_ID ==="
echo ""

# Check if we got a session ID
if [ -z "$SESSION_ID" ]; then
  echo "Failed to extract session ID"
  exit 1
fi

echo "=== Step 2: Try to resume with an answer ==="
echo ""

# Try resuming with the answer
claude --resume "$SESSION_ID" \
  -p "My favourite colour is blue." \
  --output-format stream-json \
  --model haiku 2>&1 | head -20

echo ""
echo "=== Done ==="
