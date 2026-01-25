# Feature: Update Stop Hook Context Requirements

## Overview

Update the system prompt and response messages from the stop hook to clearly communicate that when marking a step as completed or failed, the agent should provide all necessary context for subsequent steps to work from. This is crucial because next steps will **only** see the summary message - they cannot access the full conversation or outputs from the previous step.

## Problem Statement

Currently, the instructions for step completion (`cm task complete --message "..."`) are minimal:
- They tell the agent to provide "a summary of what was done"
- They don't explain **why** the message must be comprehensive
- They don't give examples of what good context looks like

When steps pass information to subsequent steps (e.g., a review step's findings, a plan step's decisions), the completion message is the **sole mechanism** for this handoff. Without clear guidance, agents may provide brief summaries that leave subsequent steps without the information they need.

## Current State Analysis

### Relevant Files

1. **`src/lib/workflow/executor.ts`** (lines 198-213)
   - `buildStepCompletionInstructions(stepName: string)` - Generates system prompt instructions appended to each step
   - Currently says:
     ```
     - **Success**: `cm task complete --message "summary of what was done"`
     - **Failure**: `cm task fail --reason "what went wrong"`
     ```

2. **`src/commands/system.ts`** (lines 127-135)
   - Stop hook handler - Outputs blocking response when step isn't marked
   - Currently says:
     ```
     Step "${stepName}" not marked complete. Run one of:
       cm task complete --message "summary"
       cm task fail --reason "what went wrong"
     ```

3. **`src/commands/task.ts`** (lines 595-624, 626-655)
   - `cm task complete` command implementation
   - `cm task fail` command implementation
   - These are the actual commands run by the agent

### How Information Flows Between Steps

From `executor.ts` and `thread-formatter.ts`:
1. When a step completes, its `completionMessage` is recorded in the thread as a `step_result` entry
2. When the next step starts, `formatThreadForContext()` formats previous entries into XML
3. The step result appears as: `<step-result step="<name>" status="success">MESSAGE HERE</step-result>`

This means the **only** information available to subsequent steps is:
- The step name
- Success/failure status
- The completion message content

## Requirements

### Functional Requirements

1. Update the system prompt (in `executor.ts`) to clearly explain:
   - The completion message is the **only** context available to subsequent steps
   - What constitutes good context for different step types
   - Examples of what to include (e.g., file paths created, key decisions, full review findings)

2. Update the stop hook block message (in `system.ts`) to:
   - Reinforce the context requirement
   - Be consistent with the system prompt guidance

### Non-Functional Requirements

- Changes should be minimal and focused
- Documentation should be clear but not overly verbose
- Should work for all step types (code, review, plan, research, etc.)

## Proposed Implementation

### Architecture

This is a documentation/prompt change only - no new modules or structural changes needed.

### Detailed Steps

#### Step 1: Update `buildStepCompletionInstructions` in `executor.ts`

**File**: `src/lib/workflow/executor.ts`
**Location**: Lines 198-213
**Change**: Expand the completion instructions to explain context requirements

```typescript
function buildStepCompletionInstructions(stepName: string): string {
  return `
## Working Directory

Your current working directory is a git worktree created for this task. Treat this directory as your project root. All file operations, searches, and code changes should be relative to this directory. Do NOT navigate to or reference parent directories or other paths outside this worktree.

## Task Completion (REQUIRED)

You are running step "${stepName}". Before finishing, you MUST run one of:

- **Success**: \`cm task complete --message "summary of what was done"\`
- **Failure**: \`cm task fail --reason "what went wrong"\`

You will be blocked from exiting until you run one of these commands.

## CRITICAL: Completion Message Context

**The completion message is the ONLY information subsequent steps will receive from your work.** Next steps cannot see your conversation, tool calls, or any files you read - they only see your completion message.

Your message must include ALL context needed for the workflow to continue:

**For implementation/code steps:**
- List specific files created or modified
- Describe key changes and their purpose
- Note any important decisions made

**For review/analysis steps:**
- Include the FULL review findings or analysis
- Provide specific file locations and line numbers
- List all issues found with severity and recommendations

**For planning steps:**
- Include the complete plan OR reference the plan file path
- List all key decisions and their rationale
- Note any assumptions or constraints

**For research/exploration steps:**
- Summarize all findings comprehensively
- Include relevant code patterns discovered
- Note file paths and locations of interest

If your work produced a document (plan, review, etc.), either:
1. Include the full content in the message, OR
2. Write it to a file and include the file path: "Full plan written to plans/feature-name.md"
`.trim();
}
```

#### Step 2: Update stop hook block message in `system.ts`

**File**: `src/commands/system.ts`
**Location**: Lines 127-135
**Change**: Update the blocking message to reinforce context requirements

```typescript
// Not marked - block exit with instructions
console.log(
  JSON.stringify({
    decision: "block",
    reason: `Step "${stepName}" not marked complete. Run one of:
  cm task complete --message "summary with full context for next steps"
  cm task fail --reason "what went wrong"

IMPORTANT: Your message is the ONLY context the next step will receive. Include all necessary information (findings, file paths, decisions, etc.) in your completion message.`,
  })
);
```

### Testing Strategy

1. **Manual Testing**: Run a multi-step workflow and verify:
   - The updated instructions appear in Claude's system prompt
   - The stop hook blocking message shows the new guidance
   - Subsequent steps receive adequate context from completion messages

2. **Existing Tests**: The existing tests in `tests/task.test.ts` cover:
   - Stop hook behavior (blocking, allowing exit)
   - Task completion/failure marking
   - These should continue to pass as we're only changing message content

3. **No New Tests Required**: This is a documentation/prompt change - the behavior remains the same, only the guidance text changes.

## Migration/Rollout

- No migration needed
- Changes take effect immediately on next task execution
- Backward compatible - existing tasks unaffected

## Open Questions

None - the implementation is straightforward.

## Summary of Changes

| File | Change |
|------|--------|
| `src/lib/workflow/executor.ts` | Expand `buildStepCompletionInstructions()` to explain context requirements |
| `src/commands/system.ts` | Update stop hook block message to reinforce context requirement |

## Appendix

### Example Good Completion Messages

**After a code review step:**
```
Review completed. Findings:

## Critical Issues (2)
1. SQL injection vulnerability in `src/api/users.ts:45` - User input passed directly to query
   - Recommendation: Use parameterized queries
2. Hardcoded credentials in `src/config/db.ts:12`
   - Recommendation: Move to environment variables

## Warnings (3)
1. Unused import in `src/utils/helpers.ts:3`
2. Missing error handling in `src/api/auth.ts:78-85`
3. Console.log left in production code at `src/index.ts:23`

## Suggestions
- Consider adding input validation middleware
- Add unit tests for auth flow

Files reviewed: src/api/*.ts, src/config/*.ts, src/utils/*.ts
```

**After a planning step:**
```
Plan created and written to plans/feature-name.md

Key decisions:
1. Will use existing auth middleware pattern from src/middleware/auth.ts
2. New endpoint will be added to src/api/users.ts
3. Database migration needed for new user_preferences table

Files to create:
- src/migrations/001_user_preferences.ts
- src/api/preferences.ts

Files to modify:
- src/api/users.ts (add import)
- src/routes/index.ts (register new route)
```
