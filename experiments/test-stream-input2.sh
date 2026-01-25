#!/bin/bash
# Test bidirectional streaming with correct message format

echo "=== Testing stream-json input/output with type:user ==="

# Initial prompt using the correct format
(
  echo '{"type":"user","message":{"role":"user","content":"Ask the user what their favourite colour is using the AskUserQuestion tool."}}'

  # Keep the connection open for a bit
  sleep 15
) | timeout 20 claude \
  --input-format stream-json \
  --output-format stream-json \
  --verbose \
  --model haiku \
  -p 2>&1 | while read -r line; do
  echo "$line"
  # Check if we got an AskUserQuestion tool use
  if echo "$line" | grep -q '"AskUserQuestion"'; then
    echo ">>> DETECTED AskUserQuestion <<<"
  fi
done

echo ""
echo "=== Done ==="
