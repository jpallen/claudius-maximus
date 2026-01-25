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

- **Primary change**: New branch name generation function in `src/lib/task/` or Claude invocation
- **Task ID validation**: May need to update `isValidTaskId()` for new format
- **Manager**: Modify `createTask()` to use Claude-generated names
- **Testing**: Mock Claude for deterministic test results

## Requirements

### Functional Requirements

1. **Branch Name Generation**:
   - Generate a short, descriptive branch name from the task description
   - Format: `kebab-case`, e.g., `implement-user-auth`, `fix-pagination-bug`
   - Length: 2-5 words (roughly 10-50 characters)
   - Must be valid git branch name (no spaces, most special chars)

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

1. **New module**: `src/lib/task/branch-name-generator.ts`
   - Contains Claude-based name generation logic
   - Isolated for testability

2. **Modifications**:
   - `src/lib/task/manager.ts`: Update `createTask()` to use new generator
   - `src/lib/task/id-generator.ts`: Keep as fallback, update validation

3. **No changes needed**:
   - Worktree creation (uses whatever ID is passed)
   - Task types (ID is just a string)
   - Commands (transparent change)

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
 */
export async function generateBranchName(
  description: string,
  cwd: string
): Promise<string | null> {
  try {
    const prompt = BRANCH_NAME_PROMPT.replace("{description}", description);

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

### Unit Tests (`tests/branch-name-generator.test.ts`)

1. **`cleanBranchName()` tests**:
   - Removes quotes: `"implement-auth"` → `implement-auth`
   - Lowercases: `Implement-Auth` → `implement-auth`
   - Replaces spaces: `implement auth` → `implement-auth`
   - Removes invalid chars: `implement@auth!` → `implementauth`
   - Handles multiple hyphens: `implement--auth` → `implement-auth`

2. **`isValidBranchName()` tests**:
   - Valid: `implement-auth`, `fix-bug`, `add-user-settings-page`
   - Invalid: empty string, too long (>60 chars), special chars
   - Invalid: leading numbers, leading hyphens

3. **`ensureUniqueBranchName()` tests**:
   - Returns name unchanged if not in set
   - Appends `-2` for first conflict
   - Appends `-3` for second conflict
   - Handles edge cases

### Integration Tests (`tests/task.test.ts`)

1. **Mock Claude returning good branch name**:
   ```typescript
   // Mock that returns a clean branch name
   const mock = createMockClaude({
     output: "implement-user-authentication"
   });
   ```
   - Verify task is created with Claude-generated name
   - Verify branch is `cm-task/implement-user-authentication`

2. **Mock Claude returning messy output**:
   ```typescript
   // Mock that returns name with extra content
   const mock = createMockClaude({
     output: '"implement-auth"\n\nThis is a good branch name.'
   });
   ```
   - Verify cleaning extracts correct name

3. **Mock Claude failure (timeout/error)**:
   ```typescript
   const mock = createMockClaude({
     exitCode: 1
   });
   ```
   - Verify fallback to random adjective-noun ID

4. **Duplicate name handling**:
   - Create task with description that generates same name
   - Verify second task gets `-2` suffix

### Edge Cases to Cover

- Very long descriptions (should still generate short name)
- Descriptions with special characters/emojis
- Non-English descriptions (Claude should handle)
- Empty description (should fallback to random)
- Network/API failures (should fallback gracefully)
- Generated name conflicts with existing task

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
