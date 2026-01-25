# AskUserQuestion in Non-Interactive Mode

## Summary

When running Claude CLI with `-p` (print/non-interactive mode), the `AskUserQuestion` tool cannot be auto-approved because it requires a UI to display options and collect user input. However, we can handle this using a **session resume** approach.

## The Problem

```bash
# Even with --dangerously-skip-permissions, AskUserQuestion gets denied
claude -p "Ask user their favourite colour" \
  --output-format stream-json \
  --dangerously-skip-permissions

# Output shows:
# {"type":"user","message":{"content":[{"type":"tool_result","content":"Answer questions?","is_error":true,...}]}
# {"type":"result",...,"permission_denials":[{"tool_name":"AskUserQuestion",...}]}
```

## The Solution: Resume Pattern

1. **Run Claude** until it asks a question (gets denied)
2. **Detect the question** from `permission_denials` in the result event
3. **Display the question** to the user and collect their answer
4. **Resume the session** with `--resume <session_id>` and the answer as the prompt

## How to Detect a Question

In the streaming output, look for the `result` event:

```json
{
  "type": "result",
  "session_id": "uuid-here",
  "permission_denials": [
    {
      "tool_name": "AskUserQuestion",
      "tool_use_id": "toolu_xxx",
      "tool_input": {
        "questions": [
          {
            "question": "What is your favourite colour?",
            "header": "Preference",
            "options": [
              {"label": "Red", "description": "A warm colour"},
              {"label": "Blue", "description": "A cool colour"}
            ],
            "multiSelect": false
          }
        ]
      }
    }
  ]
}
```

## How to Resume with Answer

```bash
claude --resume "$SESSION_ID" \
  -p 'The user answered: "Blue"' \
  --output-format stream-json \
  --dangerously-skip-permissions
```

## Implementation Sketch

```typescript
interface QuestionResult {
  sessionId: string;
  result: string;
  questionAsked: boolean;
  questionDetails?: {
    toolUseId: string;
    questions: Array<{
      question: string;
      options?: Array<{ label: string; description?: string }>;
    }>;
  };
}

async function runClaudeWithQuestionHandling(
  prompt: string,
  onQuestion: (question: QuestionResult["questionDetails"]) => Promise<string>
): Promise<string> {
  // Step 1: Run initial session
  let result = await runClaude(prompt);

  // Step 2: Handle questions in a loop
  while (result.questionAsked && result.questionDetails) {
    // Get answer from user
    const answer = await onQuestion(result.questionDetails);

    // Resume with answer
    result = await runClaude(`The user answered: "${answer}"`, {
      resume: result.sessionId
    });
  }

  return result.result;
}
```

## Test Scripts

- `test-resume-answer2.ts` - Simple demonstration of the resume approach
- `test-full-qa-flow.ts` - Complete Q&A flow with question detection and resume

## Key Flags

- `--output-format stream-json` - For detecting questions in real-time
- `--verbose` - Required with stream-json in -p mode
- `--dangerously-skip-permissions` - Auto-approve other tools
- `--resume <session_id>` - Resume a previous session
