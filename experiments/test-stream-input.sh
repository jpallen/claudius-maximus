#!/bin/bash
# Test bidirectional streaming with Claude

echo "=== Testing stream-json input/output ==="

# Create a pipe for sending input
mkfifo /tmp/claude_input 2>/dev/null || true

# Start Claude with bidirectional streaming
(
  # Initial prompt
  echo '{"type":"user_message","text":"Ask the user what their favourite colour is using the AskUserQuestion tool."}'

  # Wait a bit then close
  sleep 10
) | claude \
  --input-format stream-json \
  --output-format stream-json \
  --verbose \
  --model haiku \
  -p 2>&1 | head -50

echo ""
echo "=== Done ==="
