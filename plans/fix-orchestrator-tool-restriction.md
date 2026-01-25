# Feature: Fix Orchestrator Tool Use Restriction

## Overview

The orchestrator is executing tasks directly instead of delegating to `cm system orchestrator-decision`. This happens because the `--allowedTools` flag doesn't actually restrict which tools are available to Claude - it only affects permission prompts (which are bypassed when `bypassPermissions` mode is active).

## Root Cause Analysis

### The Problem

In `src/lib/workflow/executor.ts`, the orchestrator is invoked with:

```typescript
await runClaude({
  // ...
  allowedTools: ["Bash(cm *)"],
  // ...
});
```

In `src/lib/workflow/claude-runner.ts`, this is passed to Claude CLI as:

```typescript
if (allowedTools?.length) {
  for (const tool of allowedTools) {
    args.push("--allowedTools", tool);
  }
}
```

### Why This Doesn't Work

1. **`--allowedTools` vs `--tools`**: These are fundamentally different flags:
   - `--tools` - **Controls which tools are available** (removes tools from Claude's visible tool list)
   - `--allowedTools` - **Controls permission patterns** (which tool uses are auto-approved vs require user confirmation)

2. **Permission Mode Override**: The system often runs with `bypassPermissions` mode (either from user's `~/.claude/settings.json` or `--dangerously-skip-permissions`). In this mode, `--allowedTools` has no effect because all permissions are bypassed.

3. **Result**: Claude sees ALL tools (Read, Write, Edit, Task, etc.) and can use any of them freely, which is why the orchestrator ends up doing the task directly instead of just calling `cm system orchestrator-decision`.

### Evidence

Testing with `--allowedTools "Bash(echo *)"`:
- `init` event shows: `"tools":["Task","TaskOutput","Bash","Glob","Grep","Read","Edit","Write",...]` - ALL tools visible
- Claude freely uses `Read`, `Bash(ls)`, etc. - not restricted to `Bash(echo *)`
- `permission_denials: []` - no denials because permissions are bypassed

Testing with `--tools "Bash"`:
- `init` event shows: `"tools":["Bash"]` - ONLY Bash visible
- Claude uses `Bash(cat)` to read files since Read isn't available
- This actually restricts the available tools

## Requirements

### Functional Requirements
- Orchestrator must only be able to make decisions via `cm system orchestrator-decision`
- Orchestrator must NOT be able to read files, write files, spawn agents, etc.
- Tool restriction must work regardless of the user's permission mode setting

### Non-Functional Requirements
- Minimal changes to existing code
- Backward compatible with existing workflow configurations
- Clear separation between orchestrator and step execution contexts

## Proposed Implementation

### Architecture

The fix is simple: use `--tools` instead of `--allowedTools` (or in addition to it, for defense in depth).

### Detailed Steps

#### Step 1: Update `ClaudeRunOptions` Interface

**File:** `src/lib/workflow/claude-runner.ts`

Add a new `tools` option to restrict available tools:

```typescript
/** Options for running Claude CLI */
export interface ClaudeRunOptions {
  // ... existing options ...

  /** Allowed tools (e.g., ["Bash(cm *)"] to only allow cm commands) */
  allowedTools?: string[];
  /** Disallowed tools */
  disallowedTools?: string[];

  /** NEW: Restrict available tools (e.g., ["Bash"] to only make Bash available) */
  tools?: string[];

  /** Whether this is an orchestrator invocation (vs step execution) */
  isOrchestrator?: boolean;
}
```

#### Step 2: Update `runClaude` Function

**File:** `src/lib/workflow/claude-runner.ts`

Update the argument building logic to handle the new `tools` option:

```typescript
export async function runClaude(options: ClaudeRunOptions): Promise<ClaudeResult> {
  const {
    // ... existing destructuring ...
    tools,  // NEW
  } = options;

  // Build command arguments
  const claudeCmd = getClaudeCommand();
  const outputFormat = stream ? "stream-json" : "json";
  const args: string[] = [claudeCmd, "-p", prompt, "--output-format", outputFormat];

  // ... existing args setup ...

  // NEW: Restrict available tools (this actually limits what tools Claude can see)
  if (tools !== undefined) {
    // Note: --tools "" disables all tools, --tools "Bash" enables only Bash
    args.push("--tools", tools.join(","));
  }

  // Add tool restrictions (patterns for permission system - as defense in depth)
  if (allowedTools?.length) {
    for (const tool of allowedTools) {
      args.push("--allowedTools", tool);
    }
  }
  if (disallowedTools?.length) {
    for (const tool of disallowedTools) {
      args.push("--disallowedTools", tool);
    }
  }

  // ... rest of function ...
}
```

#### Step 3: Update Orchestrator Invocation in Executor

**File:** `src/lib/workflow/executor.ts`

Update the orchestrator's `runClaude` call to use `tools` instead of (or in addition to) `allowedTools`:

```typescript
// 3. Run Claude as orchestrator (restricted to only Bash tool for cm commands)
try {
  await runClaude({
    prompt,
    model: workflow.model || "opus",
    cwd: task.worktreePath,
    timeout: config.defaults?.timeout,
    appendSystemPrompt: buildOrchestratorSystemPrompt(workflow),
    taskId: task.id,
    stream: opts.stream,
    onStream: opts.streamOutput,
    tools: ["Bash"],           // NEW: Only Bash is available
    allowedTools: ["Bash(cm *)"],  // Keep for defense in depth
    isOrchestrator: true,
  });
}
```

### API/Interface Design

The change adds one new optional parameter to `ClaudeRunOptions`:

```typescript
tools?: string[]
```

- When `undefined` (default): All tools are available (existing behavior)
- When `[]` or `[""]`: No tools are available
- When `["Bash"]`: Only Bash tool is available
- When `["Bash", "Read"]`: Only Bash and Read are available

This mirrors the Claude CLI's `--tools` flag semantics.

## Testing Strategy

### Unit Tests

No new unit tests needed - this is a flag-passing change.

### Integration Tests

Add a test to verify orchestrator tool restriction:

**File:** `tests/task.test.ts`

```typescript
test("orchestrator should only have access to Bash tool", async () => {
  // Create a workflow where orchestrator might be tempted to use other tools
  const workflow = `
version: "1"
workflows:
  test:
    prompt: "Read the contents of test.txt and report"
    steps:
      - name: execute
        prompt: "Execute the task"
`;

  // Create test file
  await Bun.write(join(repoPath, "test.txt"), "Hello World");

  // Run task - orchestrator should NOT be able to read the file directly
  // It should use cm system orchestrator-decision to run a step
  const result = await runCli(["task", "start", "--workflow", "test", "--description", "test"]);

  // Verify orchestrator didn't read the file directly
  // (check that it called cm system orchestrator-decision instead)
});
```

### Manual Testing

1. Run `cm task start --workflow quick --description "read cm.yml"` with verbose mode
2. Observe the `init` event in the stream - should show `"tools":["Bash"]` for orchestrator
3. Orchestrator should call `cm system orchestrator-decision --step execute`
4. Step execution should have full tool access

### Edge Cases

1. **Empty tools array**: Should disable all tools (Claude can only respond with text)
2. **Invalid tool names**: Claude CLI handles this - will ignore invalid names
3. **Both `tools` and `allowedTools`**: Both should work together (tools restricts visibility, allowedTools restricts permissions within visible tools)

## Migration/Rollout

No migration needed - this is a bug fix that changes internal behavior.

### Backward Compatibility

- Existing `allowedTools` behavior is preserved
- New `tools` parameter is optional with backward-compatible default (undefined = all tools)
- Existing workflow configurations don't need to change

## Open Questions

None - the fix is straightforward.

## Appendix

### Claude CLI Flag Reference

```
--tools <tools...>
    Specify the list of available tools from the built-in set.
    Use "" to disable all tools, "default" to use all tools,
    or specify tool names (e.g. "Bash,Edit,Read").

--allowedTools, --allowed-tools <tools...>
    Comma or space-separated list of tool names to allow
    (e.g. "Bash(git:*) Edit")
```

### Code Locations

- `src/lib/workflow/claude-runner.ts` - Lines 46-82 (ClaudeRunOptions), Lines 473-530 (runClaude)
- `src/lib/workflow/executor.ts` - Lines 540-554 (orchestrator runClaude call)

### Test Evidence

Command used to verify the issue:
```bash
# With --allowedTools (doesn't work - all tools visible):
claude -p "list files" --allowedTools "Bash(echo *)" --output-format stream-json --verbose

# With --tools (works - only Bash visible):
claude -p "list files" --tools "Bash" --output-format stream-json --verbose
```
