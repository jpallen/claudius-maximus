# Feature: Fix TUI Task Creation Input Blocking

## Overview

When creating a new task in the TUI, user input should be blocked during the async task creation operation. Currently, users can continue interacting with the UI (navigating agents, pressing enter again) while a task is being created, potentially causing duplicate task creation or other race conditions.

## Current State Analysis

### Relevant Existing Code and Patterns

The TUI is built with [ink](https://github.com/vadimdemedes/ink) (v5.2.1), a React-based library for building CLI applications.

**Key files:**
- `/home/james/claudius-maximus/.cm-worktrees/fix-tui-task-creation-blocking/src/tui/App.tsx` - Main application component managing view state and async operations
- `/home/james/claudius-maximus/.cm-worktrees/fix-tui-task-creation-blocking/src/tui/components/RunModeSelector.tsx` - Agent/workflow selector where users can navigate and select
- `/home/james/claudius-maximus/.cm-worktrees/fix-tui-task-creation-blocking/src/tui/hooks/useTasks.ts` - Hook managing task CRUD operations

**Current flow:**
1. User presses `n` in list view -> view changes to "create"
2. User enters prompt and presses Enter -> view changes to "mode"
3. User navigates and selects an agent/workflow -> `handleModeSelect` is called
4. `handleModeSelect` sets `creating=true`, calls `createTask`, then sets `creating=false`

**Problem location (App.tsx lines 105-123):**
```typescript
const handleModeSelect = async (selection: RunModeSelection) => {
  if (!pendingPrompt) return;

  setCreating(true);
  try {
    await createTask({
      prompt: pendingPrompt,
      agent: selection.type === "agent" ? selection.path : undefined,
      workflow: selection.type === "workflow" ? selection.name : undefined,
    });
    setPendingPrompt(null);
    setView("list");
  } catch (err) {
    console.error("Failed to create task:", err);
  } finally {
    setCreating(false);
  }
};
```

The issue is that while `creating` is `true` and the async operation is in progress:
1. The view remains "mode" until `setView("list")` is called on success
2. The `RunModeSelector` component continues to accept input
3. Multiple presses of Enter will call `handleModeSelect` multiple times

### Input Handling Pattern in ink

The `useInput` hook in ink accepts an `isActive` option:

```typescript
useInput((input, key) => {
  // handler
}, { isActive: boolean });
```

When `isActive` is `false`, the input handler is disabled and will not be called. This is the correct mechanism to use for blocking input during async operations.

### How Other Async Operations Handle This

Looking at the merge operation in `App.tsx` (lines 71-98):
- It also has a `merging` state but does NOT pass it to `MergeView`
- The `MergeView` component continues to accept input during merge
- This is the same pattern/bug as the task creation issue

## Requirements

### Functional Requirements

1. User input MUST be blocked in the `RunModeSelector` while task creation is in progress
2. The UI MUST show a "Creating task..." indicator during the operation
3. Pressing Enter during creation MUST NOT start another task creation
4. Navigation (j/k, up/down) MUST be disabled during creation
5. Escape key SHOULD be disabled during creation (cannot cancel mid-creation)

### Non-Functional Requirements

1. The solution should be consistent with ink's recommended patterns
2. The change should be minimal and focused
3. Similar fix should be applied to the merge operation for consistency

## Proposed Implementation

### Architecture

The fix uses ink's built-in `isActive` option on `useInput` hooks to disable input during async operations. This requires:

1. Passing a `disabled` prop from `App.tsx` to components that need input blocking
2. Using the `isActive` option in `useInput` calls

### Detailed Steps

#### Step 1: Add disabled prop to RunModeSelector

**File:** `/home/james/claudius-maximus/.cm-worktrees/fix-tui-task-creation-blocking/src/tui/components/RunModeSelector.tsx`

Add `disabled` to the props interface:

```typescript
interface RunModeSelectorProps {
  onSelect: (selection: RunModeSelection) => void;
  onCancel: () => void;
  disabled?: boolean;  // NEW: disable input during async operations
}
```

Update the component to use the prop:

```typescript
export function RunModeSelector({ onSelect, onCancel, disabled = false }: RunModeSelectorProps): React.ReactElement {
```

Modify the `useInput` call to use `isActive`:

```typescript
useInput((input, key) => {
  if (key.escape) {
    onCancel();
  } else if (key.upArrow || input === "k") {
    setSelectedIndex((prev) => Math.max(0, prev - 1));
  } else if (key.downArrow || input === "j") {
    setSelectedIndex((prev) => Math.min(items.length - 1, prev + 1));
  } else if (key.return) {
    const item = items[selectedIndex];
    if (item.type === "agent") {
      onSelect({ type: "agent", path: item.value });
    } else if (item.type === "workflow") {
      onSelect({ type: "workflow", name: item.value });
    } else {
      onSelect({ type: "default" });
    }
  }
}, { isActive: !disabled });
```

#### Step 2: Pass disabled prop from App.tsx

**File:** `/home/james/claudius-maximus/.cm-worktrees/fix-tui-task-creation-blocking/src/tui/App.tsx`

Update the `RunModeSelector` usage (around line 186-194):

```typescript
{view === "mode" && (
  <RunModeSelector
    onSelect={handleModeSelect}
    onCancel={() => {
      handleModeSelect({ type: "default" });
    }}
    disabled={creating}  // NEW: disable during creation
  />
)}
```

#### Step 3: Show visual indicator during creation (already exists but improve)

The current "Creating task..." indicator is shown but the `RunModeSelector` is hidden during creation because of the conditional rendering. Actually, looking at the render logic more carefully:

```typescript
{creating && (
  <Box marginY={1}>
    <Text color="yellow">Creating task...</Text>
  </Box>
)}

{view === "mode" && (
  <RunModeSelector .../>
)}
```

Both can render at the same time since `creating` and `view === "mode"` are not mutually exclusive. This is correct - the user sees both the creating indicator AND the selector. The selector just needs to ignore input.

#### Step 4: Apply same fix to MergeView (consistency)

**File:** `/home/james/claudius-maximus/.cm-worktrees/fix-tui-task-creation-blocking/src/tui/components/MergeView.tsx`

Add `disabled` to props:

```typescript
interface MergeViewProps {
  task: Task;
  onSelect: (option: MergeOption) => void;
  onCancel: () => void;
  disabled?: boolean;  // NEW
}
```

Update component signature:

```typescript
export function MergeView({ task, onSelect, onCancel, disabled = false }: MergeViewProps): React.ReactElement {
```

Update useInput:

```typescript
useInput((input, key) => {
  if (key.escape) {
    onCancel();
  } else if (key.upArrow || input === "k") {
    setSelectedIndex((prev) => Math.max(0, prev - 1));
  } else if (key.downArrow || input === "j") {
    setSelectedIndex((prev) => Math.min(options.length - 1, prev + 1));
  } else if (key.return) {
    onSelect(options[selectedIndex].key);
  }
}, { isActive: !disabled });
```

**File:** `/home/james/claudius-maximus/.cm-worktrees/fix-tui-task-creation-blocking/src/tui/App.tsx`

Update MergeView usage (around line 196-202):

```typescript
{view === "merge" && pendingMergeTask && (
  <MergeView
    task={pendingMergeTask}
    onSelect={handleMergeSelect}
    onCancel={handleCancel}
    disabled={merging}  // NEW: disable during merge
  />
)}
```

#### Step 5: Consider disabling App.tsx useInput during operations

The main App component also has a `useInput` hook (lines 36-49). While the view checks (`if (view === "list")`) provide some protection, for extra safety during async operations we could disable it:

```typescript
useInput((input, key) => {
  if (view === "list") {
    if (input === "n") {
      setView("create");
    } else if (input === "r") {
      refresh();
    } else if (input === "m" && tasks.length > 0) {
      handleStartMerge(tasks[selectedIndex].id);
    } else if (input === "q" || key.escape) {
      exit();
    }
  }
}, { isActive: !creating && !merging });
```

However, this may be unnecessary since the view check already prevents the handler body from executing. The existing logic `if (view === "list")` means the handler does nothing when view is "mode" or "merge". This step is optional but recommended for defensive coding.

### API/Interface Design

**RunModeSelectorProps (updated):**
```typescript
interface RunModeSelectorProps {
  onSelect: (selection: RunModeSelection) => void;
  onCancel: () => void;
  disabled?: boolean;
}
```

**MergeViewProps (updated):**
```typescript
interface MergeViewProps {
  task: Task;
  onSelect: (option: MergeOption) => void;
  onCancel: () => void;
  disabled?: boolean;
}
```

## Testing Strategy

### Manual Testing

Since the TUI is interactive and there are no existing TUI tests, manual testing is recommended:

1. **Basic creation flow:**
   - Start TUI with `cm task`
   - Press `n`, enter a prompt, press Enter
   - Select an agent/workflow and press Enter
   - Verify task is created and view returns to list

2. **Double-press prevention:**
   - Start TUI, create a task as above
   - When on the mode selector, quickly press Enter multiple times
   - Verify only ONE task is created (check with `cm task list`)

3. **Navigation blocking:**
   - During task creation (when "Creating task..." is shown)
   - Try pressing j/k or arrow keys
   - Verify cursor does not move

4. **Escape blocking:**
   - During task creation
   - Press Escape
   - Verify it does not cancel the operation

5. **Merge operation:**
   - Create a task and make some commits
   - Use `m` to start merge
   - During merge, try pressing Enter again
   - Verify merge is not duplicated

### Unit Tests (Future)

Consider adding ink testing utilities in the future. The ink library provides `render` from `ink-testing-library` for testing components:

```typescript
import { render } from "ink-testing-library";

test("RunModeSelector ignores input when disabled", () => {
  const onSelect = jest.fn();
  const { stdin } = render(
    <RunModeSelector onSelect={onSelect} onCancel={() => {}} disabled={true} />
  );

  stdin.write("\r"); // Enter key
  expect(onSelect).not.toHaveBeenCalled();
});
```

This is out of scope for this fix but noted for future test coverage.

## Migration/Rollout

No migration needed. This is a bugfix with no breaking changes:
- The `disabled` prop is optional with a default of `false`
- Existing behavior is preserved when the prop is not provided

## Open Questions

None - the implementation path is clear.

## Appendix

### Files to Modify

1. `/home/james/claudius-maximus/.cm-worktrees/fix-tui-task-creation-blocking/src/tui/components/RunModeSelector.tsx`
   - Add `disabled` prop
   - Add `isActive: !disabled` to `useInput`

2. `/home/james/claudius-maximus/.cm-worktrees/fix-tui-task-creation-blocking/src/tui/components/MergeView.tsx`
   - Add `disabled` prop
   - Add `isActive: !disabled` to `useInput`

3. `/home/james/claudius-maximus/.cm-worktrees/fix-tui-task-creation-blocking/src/tui/App.tsx`
   - Pass `disabled={creating}` to `RunModeSelector`
   - Pass `disabled={merging}` to `MergeView`
   - (Optional) Add `isActive: !creating && !merging` to main `useInput`

### Estimated Complexity

Low - approximately 10-15 lines of code changes across 3 files.

### ink useInput Documentation Reference

From the ink readme:

```
##### isActive

Type: `boolean`
Default: `true`

Enable or disable capturing of user input.
Useful when there are multiple useInput hooks used at once to avoid handling the same input several times.
```

This is exactly the mechanism designed for our use case.
