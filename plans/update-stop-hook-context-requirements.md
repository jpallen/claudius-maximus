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
   - Currently provides minimal guidance with placeholder text "summary of what was done"

2. **`src/commands/system.ts`** (lines 127-147)
   - Stop hook handler - Outputs blocking response when step isn't marked
   - **TWO LOCATIONS** need updating:
     - Line 132: Primary blocking message
     - Line 142: Error case catch block (identical message)

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
   - **Lead with 'why'**: The completion message is the **only** context available to subsequent steps
   - **Then explain 'how'**: The command syntax and what to include
   - Guidance for both success and failure cases
   - Examples of what to include for different step types

2. Update the stop hook block messages (in `system.ts`) to:
   - Be concise - detailed guidance belongs in system prompt
   - Reinforce the context requirement briefly
   - Update **BOTH** occurrences (lines 132 and 142)

### Non-Functional Requirements

- Changes should be minimal and focused
- System prompt expansion to ~1500 chars is reasonable for instructional content
- Should work for all step types (code, review, plan, research, etc.)

## Proposed Implementation

### Architecture

This is a documentation/prompt change only - no new modules or structural changes needed.

### Detailed Steps

#### Step 1: Update `buildStepCompletionInstructions` in `executor.ts`

**File**: `src/lib/workflow/executor.ts`
**Location**: Lines 198-213
**Change**: Expand the completion instructions with "why" first, then "how"

```typescript
function buildStepCompletionInstructions(stepName: string): string {
  return `
## Working Directory

Your current working directory is a git worktree created for this task. Treat this directory as your project root. All file operations, searches, and code changes should be relative to this directory. Do NOT navigate to or reference parent directories or other paths outside this worktree.

## Task Completion (REQUIRED)

You are running step "${stepName}". Before finishing, you MUST run one of:

- **Success**: \`cm task complete --message "detailed context for next steps"\`
- **Failure**: \`cm task fail --reason "detailed explanation of what went wrong"\`

You will be blocked from exiting until you run one of these commands.

## CRITICAL: Your Message is the ONLY Context for Next Steps

**The completion message is the ONLY information subsequent steps will receive from your work.** Next steps cannot see your conversation, tool calls, or any files you read - they ONLY see your completion message.

Your message must include ALL context needed for the workflow to continue:

**For implementation/code steps:**
- List specific files created or modified with their paths
- Describe key changes and their purpose
- Note any important decisions made
- Include commit hashes if changes were committed

**For review/analysis steps:**
- Include the FULL review findings (not just a summary)
- Provide specific file locations and line numbers for issues
- List all issues found with severity and recommendations
- State clearly whether the review passed or requires changes

**For planning steps:**
- Include the complete plan OR reference the plan file path
- List all key decisions and their rationale
- Note any assumptions or constraints identified

**For research/exploration steps:**
- Summarize all findings comprehensively
- Include relevant code patterns discovered
- Note file paths and locations of interest

**For failure messages:**
- Explain what you were trying to do
- Describe what went wrong in detail
- Include any error messages or stack traces
- Suggest possible remediation steps if known

If your work produced a document (plan, review, etc.), either:
1. Include the full content in the message, OR
2. Write it to a file and include the file path with a summary of key points
`.trim();
}
```

#### Step 2: Update stop hook block messages in `system.ts`

**File**: `src/commands/system.ts`
**Location 1**: Lines 127-135 (primary block message)
**Location 2**: Lines 137-147 (error case catch block)
**Change**: Update both occurrences with concise messaging that reinforces the context requirement

**Location 1 (line 132):**
```typescript
// Not marked - block exit with instructions
console.log(
  JSON.stringify({
    decision: "block",
    reason: `Step "${stepName}" not marked complete. Run one of:
  cm task complete --message "<detailed context for next steps>"
  cm task fail --reason "<detailed explanation of failure>"

Remember: Your message is the ONLY context the next step will see.`,
  })
);
```

**Location 2 (line 142):**
```typescript
// If we can't load the attempt file, block exit as a safety measure
console.log(
  JSON.stringify({
    decision: "block",
    reason: `Cannot verify step completion: ${(error as Error).message}. Run one of:
  cm task complete --message "<detailed context for next steps>"
  cm task fail --reason "<detailed explanation of failure>"

Remember: Your message is the ONLY context the next step will see.`,
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

| File | Location | Change |
|------|----------|--------|
| `src/lib/workflow/executor.ts` | Lines 198-213 | Expand `buildStepCompletionInstructions()` to explain context requirements, leading with 'why' |
| `src/commands/system.ts` | Line 132 | Update primary stop hook block message with concise reminder |
| `src/commands/system.ts` | Line 142 | Update error case block message with concise reminder |

## Appendix

### Example Good Completion Messages

**After a code review step (APPROVED):**
```
## Review Complete: APPROVED

The implementation is ready to merge. All changes follow project conventions and the code is well-structured.

### Files Reviewed
- src/api/users.ts (new endpoints)
- src/middleware/auth.ts (minor refactor)
- src/models/User.ts (new fields)

### Findings
No blocking issues found.

### Minor Suggestions (non-blocking)
1. Consider adding JSDoc to the new `getUserPreferences` function in src/api/users.ts:45
2. The error message in src/middleware/auth.ts:23 could be more specific

Verdict: Approved for merge.
```

**After a code review step (NEEDS REVISION):**
```
## Review Complete: NEEDS REVISION

### Critical Issues (2)
1. **SQL injection vulnerability** in `src/api/users.ts:45`
   - User input passed directly to query
   - Recommendation: Use parameterized queries

2. **Hardcoded credentials** in `src/config/db.ts:12`
   - Recommendation: Move to environment variables

### Warnings (3)
1. Unused import in `src/utils/helpers.ts:3`
2. Missing error handling in `src/api/auth.ts:78-85`
3. Console.log left in production code at `src/index.ts:23`

### Suggestions
- Consider adding input validation middleware
- Add unit tests for auth flow

Files reviewed: src/api/*.ts, src/config/*.ts, src/utils/*.ts

Verdict: Cannot approve until critical issues are resolved.
```

**After a planning step:**
```
Plan created at plans/user-auth-feature.md

## Key Decisions
1. Will use existing auth middleware pattern from src/middleware/auth.ts
2. New endpoint will be added to src/api/users.ts
3. Database migration needed for new user_preferences table

## Files to Create
- src/migrations/001_user_preferences.ts
- src/api/preferences.ts

## Files to Modify
- src/api/users.ts (add import)
- src/routes/index.ts (register new route)

## Architecture
Using JWT tokens stored in httpOnly cookies (following existing pattern in auth.ts).
Session data stored in Redis as per current infrastructure.

Estimated complexity: Medium (3-5 hours implementation)
```

**After a failed step:**
```
## Step Failed: Could not complete implementation

### What I was trying to do
Implement the user preferences API endpoint as specified in the plan.

### What went wrong
The existing User model in src/models/User.ts uses a different ORM (TypeORM) than expected. The plan assumed Prisma based on package.json, but the actual implementation uses TypeORM.

### Error encountered
```
TypeError: User.findUnique is not a function
    at src/api/preferences.ts:23
```

### Suggested remediation
1. Update the plan to use TypeORM patterns (User.findOne instead of findUnique)
2. Review src/models/*.ts for correct query patterns
3. Re-run implementation step with corrected approach

### Files modified before failure
- src/api/preferences.ts (partial implementation - needs correction)
```
