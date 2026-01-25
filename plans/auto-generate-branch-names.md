# Feature: Auto-Generate Branch Names from Task Descriptions

## Overview

When a task is created via `cm task create`, automatically generate a descriptive branch name (e.g., `implement-auth`, `fix-pagination-bug`) from the task description using Claude. This replaces the current random adjective-noun pattern (`swift-falcon`, `brave-tiger`) with semantically meaningful branch names that reflect the actual task.

## Current State Analysis

### Relevant Existing Code

1. **Task ID Generation** (`src/lib/task/id-generator.ts`)
   - Currently generates human-readable IDs using adjective-noun pattern
   - `generateTaskId(existingIds: Set<string>)` ensures uniqueness
   - `isValidTaskId(id: string)` validates format: `/^[a-z]+-[a-z]+(-\d+)?$/`
   - These IDs become branch names as `cm-task/${taskId}`

2. **Task Creation Flow** (`src/lib/task/manager.ts`, lines 201-265)
   - `createTask()` takes workflow, options (including `description`), and repoPath
   - Calls `generateTaskId()` to get the task ID
   - Creates worktree with `createWorktree(repoPath, taskId, baseBranch)`
   - Branch is created as `cm-task/${taskId}` (in `worktree.ts` line 108)

3. **Claude Runner** (`src/lib/workflow/claude-runner.ts`)
   - `runClaude()` function for invoking Claude CLI
   - Supports models: opus, sonnet, haiku
   - Has `allowedTools` and `disallowedTools` options for tool restrictions
   - Supports `stream: false` for non-streaming JSON output

4. **System Commands** (`src/commands/system.ts`)
   - Pattern for internal CLI commands that Claude can call
   - Stop hook mechanism for validating step completion

5. **Testing Patterns** (`tests/helpers.ts`, `tests/task.test.ts`)
   - `CM_CLAUDE_COMMAND` env var for mocking Claude CLI
   - Mock scripts that simulate Claude behavior
   - E2E tests use `Bun.spawn` to run actual CLI

### Key Integration Points

- **Primary change**: New branch name generation function in `src/lib/task/`
- **Import from workflow**: Import `runClaude` and `parseClaudeOutput` directly from `workflow/claude-runner` (no re-export module needed)
- **Task ID validation**: Update `isValidTaskId()` for new format
- **Manager**: Modify `createTask()` to use Claude-generated names
- **Testing**: Mock Claude for deterministic test results using shared helper

## Requirements

### Functional Requirements

1. **Branch Name Generation**:
   - Generate a short, descriptive branch name from the task description
   - Format: `kebab-case`, e.g., `implement-user-auth`, `fix-pagination-bug`
   - Length: 2-5 words (roughly 10-50 characters)
   - Must be valid git branch name (no spaces, most special chars)
   - **Empty description handling**: If description is empty or only whitespace, fallback to random ID

2. **Claude Integration**:
   - Use Claude (haiku for speed/cost) to generate the name
   - No tools needed - pure text generation
   - Clear instructions to return ONLY the branch name

3. **Uniqueness Handling**:
   - Check if generated name conflicts with existing task IDs
   - If conflict, append numeric suffix: `implement-auth-2`
   - Fallback to random ID if Claude fails

4. **Backward Compatibility**:
   - Existing tasks with adjective-noun IDs continue to work
   - `isValidTaskId()` should accept both old and new formats

### Non-Functional Requirements

- **Performance**: Name generation should add <3 seconds to task creation
- **Cost**: Use haiku model to minimize API costs
- **Reliability**: Graceful fallback if Claude is unavailable
- **Testability**: Must work with mock Claude in tests

## Proposed Implementation

### Architecture

1. **New modules**:
   - `src/lib/task/branch-name-generator.ts`: Contains Claude-based name generation logic, isolated for testability

2. **Modifications**:
   - `src/lib/task/manager.ts`: Update `createTask()` to use new generator
   - `src/lib/task/id-generator.ts`: Keep as fallback, update validation
   - `tests/helpers.ts`: Add shared `createSimpleMockClaude()` test helper

3. **No changes needed**:
   - Worktree creation (uses whatever ID is passed)
   - Task types (ID is just a string)
   - Commands (transparent change)
   - No re-export module needed - import directly from `workflow/claude-runner`

### Detailed Steps

#### Step 1: Create `src/lib/task/branch-name-generator.ts`

```typescript
/**
 * Generate semantic branch names from task descriptions using Claude
 */

import { runClaude, parseClaudeOutput } from "../workflow/claude-runner";

/** Prompt for Claude to generate branch names */
const BRANCH_NAME_PROMPT = `Generate a short, descriptive git branch name for this task.

Requirements:
- Use kebab-case (lowercase words separated by hyphens)
- 2-5 words maximum
- Describe the main action/change (e.g., "implement-auth", "fix-pagination-bug", "add-user-settings")
- Start with a verb when possible (implement, add, fix, update, refactor, remove)
- No special characters except hyphens
- No spaces

Task description:
{description}

Return ONLY the branch name, nothing else. No explanation, no quotes, just the branch name.`;

/**
 * Generate a branch name from a task description using Claude
 *
 * @param description - The task description to generate a branch name from
 * @param cwd - Working directory for Claude CLI invocation. This is typically the
 *              repository root path. Required because Claude CLI needs to run in
 *              a valid directory context, even though this function doesn't use
 *              any files from the directory.
 * @returns Generated branch name, or null if generation fails
 */
export async function generateBranchName(
  description: string,
  cwd: string
): Promise<string | null> {
  // Handle empty or whitespace-only descriptions
  if (!description || !description.trim()) {
    return null;
  }

  try {
    const prompt = BRANCH_NAME_PROMPT.replace("{description}", description.trim());

    const result = await runClaude({
      prompt,
      model: "haiku", // Fast and cheap
      cwd,
      timeout: 10000, // 10 second timeout
      stream: false,
      // No tools needed - pure text generation
      allowedTools: [],
    });

    if (!result.success) {
      return null;
    }

    const parsed = parseClaudeOutput(result.stdout);
    if (!parsed.result) {
      return null;
    }

    // Clean and validate the result
    const branchName = cleanBranchName(parsed.result);

    if (!isValidBranchName(branchName)) {
      return null;
    }

    return branchName;
  } catch {
    // Fail silently - caller will use fallback
    return null;
  }
}

/**
 * Clean up Claude's response to get a valid branch name
 */
function cleanBranchName(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    // Remove any quotes Claude might have added
    .replace(/^["'`]+|["'`]+$/g, "")
    // Remove any leading/trailing whitespace and newlines
    .trim()
    // Replace any remaining spaces with hyphens
    .replace(/\s+/g, "-")
    // Remove invalid characters (keep only alphanumeric and hyphens)
    .replace(/[^a-z0-9-]/g, "")
    // Collapse multiple hyphens
    .replace(/-+/g, "-")
    // Remove leading/trailing hyphens
    .replace(/^-+|-+$/g, "");
}

/**
 * Validate that a string is a valid branch name
 */
function isValidBranchName(name: string): boolean {
  // Must be non-empty
  if (!name || name.length === 0) return false;

  // Must be reasonable length (2-60 chars)
  if (name.length < 2 || name.length > 60) return false;

  // Must match expected format
  const pattern = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
  return pattern.test(name);
}

/**
 * Ensure a branch name is unique by appending a suffix if needed
 */
export function ensureUniqueBranchName(
  name: string,
  existingIds: Set<string>
): string {
  if (!existingIds.has(name)) {
    return name;
  }

  // Try adding numeric suffixes
  let suffix = 2;
  while (true) {
    const candidate = `${name}-${suffix}`;
    if (!existingIds.has(candidate)) {
      return candidate;
    }
    suffix++;

    // Safety limit
    if (suffix > 1000) {
      break;
    }
  }

  // This shouldn't happen, but fallback to timestamp
  return `${name}-${Date.now()}`;
}
```

#### Step 2: Update `src/lib/task/id-generator.ts`

Update the validation function to accept both formats:

```typescript
/**
 * Validate that a string is a valid task ID format
 * Accepts both:
 * - Original adjective-noun format: swift-falcon, brave-tiger-2
 * - New semantic format: implement-auth, fix-pagination-bug-3
 */
export function isValidTaskId(id: string): boolean {
  // Must be non-empty and reasonable length
  if (!id || id.length < 3 || id.length > 60) return false;

  // Must be lowercase alphanumeric with hyphens
  // Allows: word-word, word-word-word, word-word-number
  const pattern = /^[a-z][a-z0-9]*(-[a-z0-9]+)*(-\d+)?$/;
  return pattern.test(id);
}
```

#### Step 3: Update `src/lib/task/manager.ts`

Modify `createTask()` to use Claude-generated names with fallback:

```typescript
// Add import at top
import { generateBranchName, ensureUniqueBranchName } from "./branch-name-generator";

/**
 * Create a new task
 */
export async function createTask(
  workflow: Workflow,
  workflowName: string,
  options: CreateTaskOptions,
  repoPath?: string
): Promise<Task> {
  await ensureTasksDir();

  // Get repo path
  const actualRepoPath = repoPath || (await findGitRoot(process.cwd()));

  // Determine base branch
  let baseBranch: string;
  if (options.baseBranch) {
    if (!(await branchExists(actualRepoPath, options.baseBranch))) {
      throw new InvalidBranchError(options.baseBranch);
    }
    baseBranch = options.baseBranch;
  } else {
    baseBranch = await getCurrentBranch(actualRepoPath);
  }

  // Get existing task IDs for uniqueness check
  const existingIds = await getExistingTaskIds();

  // Generate task ID - try Claude first, fallback to random
  let taskId: string;

  // Try to generate a semantic branch name from the description
  const generatedName = await generateBranchName(
    options.description,
    actualRepoPath
  );

  if (generatedName) {
    // Ensure uniqueness
    taskId = ensureUniqueBranchName(generatedName, existingIds);
  } else {
    // Fallback to original random ID generation
    taskId = generateTaskId(existingIds);
  }

  // Rest of the function remains unchanged...
  const worktreePath = await createWorktree(actualRepoPath, taskId, baseBranch);
  // ...
}
```

#### Step 4: Export new functions from branch-name-generator

Update the module exports to ensure testability:

```typescript
// At end of branch-name-generator.ts
export { cleanBranchName, isValidBranchName };
```

#### Step 5: Add shared test helper to `tests/helpers.ts`

Add a lightweight mock Claude helper for simple output scenarios. Uses a file-based approach to avoid shell escaping issues:

```typescript
/**
 * Create a simple mock Claude script that returns a fixed output
 * Lighter weight than createMockClaude() for branch name generation tests
 *
 * Uses a file-based output approach to avoid shell escaping issues with
 * complex strings containing quotes, newlines, or special characters.
 */
export async function createSimpleMockClaude(
  baseDir: string,
  options: {
    /** Output to return in the JSON result field */
    output: string;
    /** Exit code to return (default: 0) */
    exitCode?: number;
    /** Track invocations by touching a flag file (default: false) */
    trackInvocations?: boolean;
  }
): Promise<{ scriptPath: string; invocationFlagPath?: string }> {
  const scriptPath = join(baseDir, "simple-mock-claude");
  const outputPath = join(baseDir, "mock-claude-output.json");
  const invocationFlagPath = join(baseDir, "claude-was-called");

  const { output, exitCode = 0, trackInvocations = false } = options;

  // Write the JSON output to a file (avoids shell escaping issues)
  const jsonOutput = JSON.stringify({ result: output });
  await Bun.write(outputPath, jsonOutput);

  // Script reads from file instead of echoing escaped string
  // Optionally touches a flag file to track invocations
  const script = `#!/bin/bash
# Simple mock Claude CLI for testing
# Reads output from a file to avoid shell escaping issues
${trackInvocations ? `\ntouch "${invocationFlagPath}"` : ""}

cat "${outputPath}"
exit ${exitCode}
`;

  await Bun.write(scriptPath, script);
  await chmod(scriptPath, 0o755);

  return {
    scriptPath,
    ...(trackInvocations ? { invocationFlagPath } : {}),
  };
}
```

### API/Interface Design

#### New Public Functions

```typescript
// src/lib/task/branch-name-generator.ts

/**
 * Generate a branch name from a task description using Claude
 * @param description - The task description
 * @param cwd - Working directory for Claude invocation
 * @returns Generated branch name or null if generation fails
 */
async function generateBranchName(
  description: string,
  cwd: string
): Promise<string | null>

/**
 * Ensure a branch name is unique by appending suffix if needed
 * @param name - The proposed branch name
 * @param existingIds - Set of existing task IDs
 * @returns Unique branch name
 */
function ensureUniqueBranchName(
  name: string,
  existingIds: Set<string>
): string
```

#### Modified Validation

```typescript
// src/lib/task/id-generator.ts

/**
 * Validate task ID - now accepts semantic names
 * Old format: swift-falcon, brave-tiger-2
 * New format: implement-auth, fix-pagination-bug-3
 */
function isValidTaskId(id: string): boolean
```

## Testing Strategy

Tests should follow E2E-first approach: start with integration tests that exercise the full flow, then add unit tests for edge cases and cleanup utilities.

### E2E/Integration Tests (`tests/branch-name-generator.test.ts`)

Use the shared `createSimpleMockClaude()` helper from `tests/helpers.ts` for these tests:

1. **Task creation uses Claude-generated branch name**:
   ```typescript
   // Mock that returns a clean branch name
   const { scriptPath } = await createSimpleMockClaude(baseDir, {
     output: "implement-user-authentication"
   });
   // Set CM_CLAUDE_COMMAND env var and run task create
   // Verify task is created with Claude-generated name
   // Verify git branch exists as `cm-task/implement-user-authentication`
   const branches = await runGit(["branch", "-l"], { cwd: repoPath });
   expect(branches.stdout).toContain("cm-task/implement-user-authentication");
   ```

2. **Fallback to random ID when Claude fails (non-zero exit)**:
   ```typescript
   const { scriptPath } = await createSimpleMockClaude(baseDir, {
     output: "",
     exitCode: 1
   });
   // Verify fallback to random adjective-noun ID pattern
   // Verify task ID matches /^[a-z]+-[a-z]+$/
   ```

3. **Fallback to random ID for empty description (no Claude call)**:
   ```typescript
   // Create mock with invocation tracking
   const { scriptPath, invocationFlagPath } = await createSimpleMockClaude(baseDir, {
     output: "should-not-be-used",
     trackInvocations: true
   });
   // Create task with empty description
   // Verify fallback to random adjective-noun ID pattern
   // Verify Claude was NOT called - invocationFlagPath should not exist
   expect(await Bun.file(invocationFlagPath!).exists()).toBe(false);
   ```

4. **Fallback to random ID for unusable output**:
   ```typescript
   // Mock returns output that's invalid after cleaning
   const { scriptPath } = await createSimpleMockClaude(baseDir, {
     output: "!!!"  // Cleans to empty string
   });
   // Verify fallback to random adjective-noun ID pattern
   ```

5. **Fallback for too-short generated names**:
   ```typescript
   const { scriptPath } = await createSimpleMockClaude(baseDir, {
     output: "a"  // Single char is too short
   });
   // Verify fallback to random adjective-noun ID pattern
   ```

6. **Fallback for too-long generated names**:
   ```typescript
   const { scriptPath } = await createSimpleMockClaude(baseDir, {
     output: "a".repeat(100)  // >60 chars is too long
   });
   // Verify fallback to random adjective-noun ID pattern
   ```

7. **Duplicate name handling**:
   ```typescript
   // Create two tasks with same description that generates same name
   // Verify first task gets base name, second task gets `-2` suffix
   ```

8. **Messy Claude output is cleaned**:
   ```typescript
   const { scriptPath } = await createSimpleMockClaude(baseDir, {
     output: '"implement-auth"\n\nThis is a good branch name.'
   });
   // Verify cleaning extracts correct name: implement-auth
   ```

9. **Timeout handling**:
   ```typescript
   // Create a mock that sleeps longer than timeout
   const scriptPath = join(baseDir, "slow-mock-claude");
   await Bun.write(scriptPath, `#!/bin/bash\nsleep 20\necho '{"result":"should-not-reach"}'`);
   // With a 1s timeout configured, verify fallback to random ID
   ```

### Unit Tests (`tests/branch-name-generator.test.ts`)

Test the pure functions without Claude invocation:

1. **`cleanBranchName()` tests**:
   - Removes double quotes: `"implement-auth"` → `implement-auth`
   - Removes single quotes: `'implement-auth'` → `implement-auth`
   - Removes backticks: `` `implement-auth` `` → `implement-auth`
   - Lowercases: `Implement-Auth` → `implement-auth`
   - Replaces spaces: `implement auth` → `implement-auth`
   - Removes invalid chars: `implement@auth!` → `implementauth`
   - Handles multiple hyphens: `implement--auth` → `implement-auth`
   - Removes leading hyphens: `-implement-auth` → `implement-auth`
   - Removes trailing hyphens: `implement-auth-` → `implement-auth`

2. **`isValidBranchName()` tests**:
   - Valid: `implement-auth`, `fix-bug`, `add-user-settings-page`
   - Valid: single word `auth` (minimum 2 chars)
   - Invalid: empty string
   - Invalid: too short (1 char)
   - Invalid: too long (>60 chars)
   - Invalid: special characters
   - Invalid: leading numbers `1-fix-bug`
   - Invalid: leading hyphens `-fix-bug`
   - Invalid: contains uppercase `Fix-Bug`

3. **`ensureUniqueBranchName()` tests**:
   - Returns name unchanged if not in set
   - Appends `-2` for first conflict
   - Appends `-3` for second conflict
   - Handles name that already ends with suffix (`foo-2` → `foo-2-2` if `foo-2` exists)
   - Returns correct suffix when multiple conflicts exist (e.g., `foo`, `foo-2`, `foo-3` → `foo-4`)

### Edge Cases to Cover

- Very long descriptions (should still generate short name)
- Descriptions with special characters/emojis
- Non-English descriptions (Claude should handle)
- Empty description (should fallback to random - explicit check added)
- Whitespace-only description (should fallback to random - explicit check added)
- Network/API failures (should fallback gracefully)
- Generated name conflicts with existing task
- Claude output that's only quotes/special chars (invalid after cleaning)
- Generated name exactly at length boundaries (2 chars, 60 chars)

## Migration/Rollout

### Backward Compatibility

- **Fully backward compatible**: Existing tasks with adjective-noun IDs work unchanged
- The validation regex accepts both old and new formats
- No changes to task storage format or worktree structure

### No Migration Required

- Existing tasks keep their IDs
- New tasks get Claude-generated names (or fallback to old format)
- No config changes needed

### Rollout Considerations

- Feature is opt-in by default (happens automatically on task create)
- If Claude is unavailable, falls back silently to old behavior
- Consider adding `--random-id` flag if users prefer old behavior (future enhancement)

## Open Questions

All major questions have been resolved. The following are documented for future reference:

1. **Should there be a `--random-id` flag?**
   - Not implementing initially - fallback behavior covers this
   - Can add later if users request it

2. **Should we cache/remember Claude-generated names?**
   - Not needed - names are only generated once at creation
   - Stored in task.json like before

3. **What if the generated name is inappropriate?**
   - Claude should follow instructions to generate professional names
   - Haiku model is generally well-behaved
   - User can always delete and recreate task

## Revision Notes

### Revision 3 (addressing second review)

1. ✅ **Removed unnecessary re-export module**: Import directly from `workflow/claude-runner` instead of creating `src/lib/claude.ts`
2. ✅ **Fixed createSimpleMockClaude() shell escaping**: Changed to file-based output approach - write JSON to a file, script uses `cat` to read it
3. ✅ **Added missing E2E test cases**:
   - Unusable output (cleans to empty)
   - Too-short names (< 2 chars)
   - Too-long names (> 60 chars)
   - Timeout behavior
   - No-Claude-call verification for empty description
   - Git branch verification in success case
4. ✅ **Expanded unit tests**:
   - `cleanBranchName()`: backticks, leading/trailing hyphens
   - `isValidBranchName()`: single-word names, exact boundary lengths
   - `ensureUniqueBranchName()`: pre-existing suffixes, multiple conflicts
5. ✅ **Added cwd parameter documentation**: Added detailed JSDoc explaining why cwd is needed

### Revision 2 (addressing first review)

1. ✅ **Shared test helper**: Added `createSimpleMockClaude()` to `tests/helpers.ts` for lightweight mocking
2. ✅ **E2E-first testing**: Restructured Testing Strategy to put integration tests before unit tests
3. ✅ **Re-export module**: Originally added `src/lib/claude.ts` (removed in revision 3)
4. ✅ **Empty description handling**: Added explicit check for empty/whitespace-only descriptions at start of `generateBranchName()`

## Appendix

### Example Generated Branch Names

| Task Description | Expected Branch Name |
|-----------------|---------------------|
| "Add user authentication with OAuth2" | `add-user-authentication-oauth2` or `implement-oauth2-auth` |
| "Fix the pagination bug on the products page" | `fix-pagination-bug-products` or `fix-products-pagination` |
| "Refactor database queries for better performance" | `refactor-database-queries` |
| "Update README with installation instructions" | `update-readme-installation` |
| "Remove deprecated API endpoints" | `remove-deprecated-api-endpoints` |

### Why Haiku Model?

- **Speed**: ~1-2 seconds vs 3-5 seconds for Sonnet
- **Cost**: Much cheaper per token
- **Capability**: Simple text generation task doesn't need Opus/Sonnet intelligence
- **Reliability**: Haiku is very good at following simple instructions

### Alternative Approaches Considered

1. **Local generation (regex/NLP)**:
   - Pro: No API call, faster
   - Con: Lower quality, harder to maintain
   - Rejected: Claude is already available and produces better results

2. **User prompt for branch name**:
   - Pro: User control
   - Con: Extra friction, defeats purpose
   - Rejected: Want automatic generation

3. **Use task description directly (truncated)**:
   - Pro: No API call
   - Con: Poor branch names from long descriptions
   - Rejected: Claude produces much better names
